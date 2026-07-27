import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { ClusterBusService } from '../src/cluster/cluster-bus.service';
import { ClusterRpcService } from '../src/cluster/cluster-rpc.service';
import { LeaseService } from '../src/cluster/lease.service';

const HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const PORT = Number(process.env.REDIS_PORT ?? 6380);

const conf = (overrides: Record<string, string> = {}) =>
  ({
    get: (key: string, fallback?: string) =>
      overrides[key] ?? { LEASE_TTL_MS: '5000', LEASE_RENEW_MS: '60000' }[key] ?? fallback,
  }) as unknown as ConfigService;

/**
 * Deliberately NOT the app's `maxRetriesPerRequest: null` (which BullMQ
 * requires): in a test, an unreachable Redis must fail the assertion rather
 * than retry forever and hang the runner until CI times out.
 */
const client = () =>
  new Redis({
    host: HOST,
    port: PORT,
    maxRetriesPerRequest: 2,
    connectTimeout: 2_000,
    // Give up after a few attempts instead of reconnecting forever. Returning
    // null immediately would be wrong too — it forbids even the first
    // reconnect, so commands fail before the client has finished connecting.
    retryStrategy: (times: number) => (times > 3 ? null : 200),
  });

/** Resolve on the next occurrence of `event`, or reject after `ms`. */
function waitFor(bus: EventEmitter2, event: string, ms = 1500): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    bus.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 250));

describe('ClusterBusService (integration, real Redis)', () => {
  const redises: Redis[] = [];
  const buses: ClusterBusService[] = [];
  let emitterA: EventEmitter2;
  let emitterB: EventEmitter2;

  beforeEach(async () => {
    emitterA = new EventEmitter2({ wildcard: true, delimiter: '.' });
    emitterB = new EventEmitter2({ wildcard: true, delimiter: '.' });
    const rA = client();
    const rB = client();
    redises.push(rA, rB);
    const busA = new ClusterBusService(rA, 'pod-a', emitterA);
    const busB = new ClusterBusService(rB, 'pod-b', emitterB);
    buses.push(busA, busB);
    await busA.onModuleInit();
    await busB.onModuleInit();
    await settle();
  });

  afterEach(async () => {
    for (const b of buses.splice(0)) await b.onApplicationShutdown();
    for (const r of redises.splice(0)) await r.quit();
  });

  it('delivers a call event raised on one pod to another pod', async () => {
    const seen = waitFor(emitterB, 'call.ringing');
    emitterA.emit('call.ringing', { callId: 'c1', tenantId: 'tenant-a', agentExt: '1001' });

    await expect(seen).resolves.toMatchObject({ callId: 'c1', agentExt: '1001' });
  });

  it('does not echo a received event back onto the cluster', async () => {
    // Without loop prevention this ping-pongs forever; assert pod A never
    // sees its own event come back after pod B re-emits it locally.
    let bounced = 0;
    emitterA.on('call.ended', () => (bounced += 1));

    emitterA.emit('call.ended', { callId: 'c2', tenantId: 'tenant-a' });
    await settle();

    expect(bounced).toBe(1); // the local emit only
  });

  it('keeps the raw AMI firehose local to the pod holding the socket', async () => {
    let leaked = 0;
    emitterB.on('ami.event', () => (leaked += 1));

    emitterA.emit('ami.event', { connectionId: 'x', msg: { Event: 'Newchannel' } });
    await settle();

    expect(leaked).toBe(0);
  });

  it('never leaks its internal marker into a serialized payload', async () => {
    const seen = waitFor(emitterB, 'call.answered');
    emitterA.emit('call.answered', { callId: 'c3', tenantId: 'tenant-a' });
    const payload = await seen;

    // Webhook bodies and CRM writes are JSON — the marker must not appear.
    expect(JSON.parse(JSON.stringify(payload))).toEqual({ callId: 'c3', tenantId: 'tenant-a' });
    expect(Object.keys(payload as object)).toEqual(['callId', 'tenantId']);
  });
});

describe('ClusterRpcService (integration, real Redis)', () => {
  const redises: Redis[] = [];
  let ownerRpc: ClusterRpcService;
  let callerRpc: ClusterRpcService;
  let ownerLease: LeaseService;
  let callerLease: LeaseService;
  let connectionId: string;

  beforeEach(async () => {
    connectionId = `rpc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rOwner = client();
    const rCaller = client();
    redises.push(rOwner, rCaller);

    ownerLease = new LeaseService(rOwner, 'pod-owner', conf());
    callerLease = new LeaseService(rCaller, 'pod-caller', conf());
    ownerRpc = new ClusterRpcService(rOwner, 'pod-owner', ownerLease, conf({ CLUSTER_RPC_TIMEOUT_MS: '600' }));
    callerRpc = new ClusterRpcService(
      rCaller,
      'pod-caller',
      callerLease,
      conf({ CLUSTER_RPC_TIMEOUT_MS: '600' }),
    );
    await ownerRpc.onModuleInit();
    await callerRpc.onModuleInit();
    await settle();
  });

  afterEach(async () => {
    await ownerRpc.onApplicationShutdown();
    await callerRpc.onApplicationShutdown();
    await ownerLease.onApplicationShutdown();
    await callerLease.onApplicationShutdown();
    for (const r of redises.splice(0)) await r.quit();
  });

  it('routes a command to the pod holding the lease', async () => {
    await ownerLease.tryAcquire('ami', connectionId);
    ownerRpc.register('originate', async (id: string, ...args: never[]) => ({
      ranOn: 'pod-owner',
      id,
      args,
    }));

    await expect(
      callerRpc.call('ami', connectionId, 'originate', '1001', '1000'),
    ).resolves.toEqual({ ranOn: 'pod-owner', id: connectionId, args: ['1001', '1000'] });
  });

  it('stays silent on pods that do not own the connection', async () => {
    // Nobody holds the lease: the request must not be answered by anyone,
    // rather than being served by whichever pod happens to hear it.
    let ran = 0;
    ownerRpc.register('originate', async () => {
      ran += 1;
      return 'should not happen';
    });

    await expect(callerRpc.call('ami', connectionId, 'originate')).rejects.toThrow(/No pod answered/);
    expect(ran).toBe(0);
  });

  it("propagates the owner's error text, not a generic failure", async () => {
    await ownerLease.tryAcquire('ami', connectionId);
    ownerRpc.register('sendAction', async () => {
      throw new Error('AMI action CoreShowChannels failed: Permission denied');
    });

    await expect(callerRpc.call('ami', connectionId, 'sendAction')).rejects.toThrow(
      /CoreShowChannels failed: Permission denied/,
    );
  });

  it('rejects an unknown method instead of hanging until timeout', async () => {
    await ownerLease.tryAcquire('ami', connectionId);

    await expect(callerRpc.call('ami', connectionId, 'nope')).rejects.toThrow(/Unknown cluster method/);
  });
});
