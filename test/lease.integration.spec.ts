import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { LeaseService } from '../src/cluster/lease.service';

/**
 * Ownership is what stops two replicas driving one PBX, so it is tested
 * against a real Redis: the guarantees live in Lua compare-and-swap
 * semantics that a fake client would only pretend to have.
 */
const HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const PORT = Number(process.env.REDIS_PORT ?? 6380);

/**
 * Deliberately NOT the app's `maxRetriesPerRequest: null` (which BullMQ
 * requires): in a test, an unreachable Redis must fail the assertion, not
 * retry forever and hang the runner until CI times out.
 */
const REDIS_OPTS = {
  host: HOST,
  port: PORT,
  maxRetriesPerRequest: 2,
  connectTimeout: 2_000,
  // Give up after a few attempts instead of reconnecting forever. Returning
  // null immediately would be wrong too — it forbids even the first
  // reconnect, so commands fail before the client has finished connecting.
  retryStrategy: (times: number) => (times > 3 ? null : 200),
};

const conf = () =>
  ({
    get: (key: string, fallback?: string) => {
      if (key === 'LEASE_TTL_MS') return '2000';
      if (key === 'LEASE_RENEW_MS') return '60000'; // renewals are driven by hand
      return fallback;
    },
  }) as unknown as ConfigService;

describe('LeaseService (integration, real Redis)', () => {
  let redisA: Redis;
  let redisB: Redis;
  let podA: LeaseService;
  let podB: LeaseService;
  let connectionId: string;

  beforeEach(() => {
    redisA = new Redis(REDIS_OPTS);
    redisB = new Redis(REDIS_OPTS);
    podA = new LeaseService(redisA, 'pod-a', conf());
    podB = new LeaseService(redisB, 'pod-b', conf());
    connectionId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  });

  afterEach(async () => {
    await redisA.del(LeaseService.key('ami', connectionId));
    await podA.onApplicationShutdown();
    await podB.onApplicationShutdown();
    await redisA.quit();
    await redisB.quit();
  });

  it('grants a lease to one pod and refuses it to the other', async () => {
    await expect(podA.tryAcquire('ami', connectionId)).resolves.toBe(true);
    await expect(podB.tryAcquire('ami', connectionId)).resolves.toBe(false);

    expect(podA.holds('ami', connectionId)).toBe(true);
    expect(podB.holds('ami', connectionId)).toBe(false);
  });

  it('renews only for the current owner, and tells the loser to stand down', async () => {
    await podA.tryAcquire('ami', connectionId);

    const lost: Array<[string, string]> = [];
    podA.onLost((kind, id) => lost.push([kind, id]));

    // Still ours: renewal keeps it, no notification.
    await podA['renewAll']();
    expect(podA.holds('ami', connectionId)).toBe(true);
    expect(lost).toEqual([]);

    // A reverse tunnel lands on pod B, which takes ownership.
    await podB.forceClaim('ami', connectionId);

    // Pod A only finds out at its next renewal — and must then stop serving.
    await podA['renewAll']();
    expect(podA.holds('ami', connectionId)).toBe(false);
    expect(lost).toEqual([['ami', connectionId]]);
    expect(podB.holds('ami', connectionId)).toBe(true);
  });

  it('releases on shutdown so a peer takes over without waiting out the TTL', async () => {
    await podA.tryAcquire('ami', connectionId);
    expect(await podB.tryAcquire('ami', connectionId)).toBe(false);

    await podA.onApplicationShutdown();

    expect(await podB.tryAcquire('ami', connectionId)).toBe(true);
  });

  it('will not let a stale pod release a lease it no longer owns', async () => {
    await podA.tryAcquire('ami', connectionId);
    await podB.forceClaim('ami', connectionId);

    await podA.release('ami', connectionId);

    // Pod B's ownership must survive pod A's exit.
    expect(await redisA.get(LeaseService.key('ami', connectionId))).toBe('pod-b');
  });

  it('leases ami and files independently, since the two tunnels can differ', async () => {
    expect(await podA.tryAcquire('ami', connectionId)).toBe(true);
    expect(await podB.tryAcquire('files', connectionId)).toBe(true);

    expect(podA.holds('files', connectionId)).toBe(false);
    expect(podB.holds('ami', connectionId)).toBe(false);

    await redisB.del(LeaseService.key('files', connectionId));
  });

  it('reports cluster-wide ownership for the admin view', async () => {
    await podA.tryAcquire('ami', connectionId);

    const mine = (await podA.ownership()).filter((l) => l.connectionId === connectionId);
    expect(mine).toHaveLength(1);
    expect(mine[0].podId).toBe('pod-a');
    expect(mine[0].kind).toBe('ami');
    expect(mine[0].ttlMs).toBeGreaterThan(0);
  });
});
