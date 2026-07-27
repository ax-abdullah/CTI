import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { POD_IDENTITY } from './cluster.types';

/**
 * A PBX connection is served over two independent sockets when the customer
 * runs the reverse connector: the AMI tunnel (`/connector-ws`) and the file
 * channel (`/connector-files`). Those can land on different pods, so each is
 * leased separately and answered by whichever pod actually holds it.
 */
export type LeaseKind = 'ami' | 'files';

export interface LeaseHolder {
  kind: LeaseKind;
  connectionId: string;
  podId: string;
  ttlMs: number;
}

type LostListener = (kind: LeaseKind, connectionId: string) => void;

/**
 * Single-writer ownership across replicas (ADR-0012).
 *
 * Exactly one process may drive a given PBX connection: without this, every
 * replica opens its own AMI socket, runs its own correlation engine, and
 * enqueues its own delivery job — turning one real call into N CRM records.
 *
 * A lease is a Redis key holding this pod's id with a short TTL, renewed on a
 * timer. Renewal and release are compare-and-swap against the pod id, so a
 * process that has been away longer than the TTL can never resurrect an
 * ownership another pod has since taken.
 */
@Injectable()
export class LeaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(LeaseService.name);
  private readonly held = new Set<string>();
  private readonly lostListeners: LostListener[] = [];
  private renewTimer?: ReturnType<typeof setInterval>;
  private shuttingDown = false;

  /** Lease lifetime. A pod that dies is replaced after at most this long. */
  private readonly ttlMs: number;
  /** Renewal cadence — must be comfortably under ttlMs. */
  private readonly renewMs: number;
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    /** This process's identity; every compare-and-swap is against it. */
    @Inject(POD_IDENTITY) readonly podId: string,
    config: ConfigService,
  ) {
    this.ttlMs = Number(config.get('LEASE_TTL_MS', '30000'));
    this.renewMs = Number(config.get('LEASE_RENEW_MS', '10000'));

    // Compare-and-* as Lua so the check and the write cannot interleave with
    // another pod's claim.
    this.redis.defineCommand('leaseRenew', {
      numberOfKeys: 1,
      lua: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`,
    });
    this.redis.defineCommand('leaseRelease', {
      numberOfKeys: 1,
      lua: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
    });

    this.renewTimer = setInterval(() => void this.renewAll(), this.renewMs);
    this.renewTimer.unref();
  }

  static key(kind: LeaseKind, connectionId: string): string {
    return `cti:lease:${kind}:${connectionId}`;
  }

  private static parse(key: string): { kind: LeaseKind; connectionId: string } {
    const [, , kind, connectionId] = key.split(':');
    return { kind: kind as LeaseKind, connectionId };
  }

  /** Notified when a lease is lost — the holder must stop serving at once. */
  onLost(listener: LostListener): void {
    this.lostListeners.push(listener);
  }

  holds(kind: LeaseKind, connectionId: string): boolean {
    return this.held.has(LeaseService.key(kind, connectionId));
  }

  heldCount(): number {
    return this.held.size;
  }

  /**
   * Claim only if unowned. The normal path for `direct` connections, where
   * any pod is equally able to dial the PBX.
   */
  async tryAcquire(kind: LeaseKind, connectionId: string): Promise<boolean> {
    if (this.shuttingDown) return false;
    const key = LeaseService.key(kind, connectionId);
    const res = await this.redis.set(key, this.podId, 'PX', this.ttlMs, 'NX');
    if (res === 'OK') {
      this.held.add(key);
      this.logger.log(`Acquired ${kind} lease for ${connectionId}`);
      return true;
    }
    return this.held.has(key);
  }

  /**
   * Take ownership regardless of the current holder. Used when a reverse
   * tunnel arrives: the connection can only be live on the pod the customer's
   * agent actually dialled into, so that pod's claim is authoritative and the
   * previous holder — which by definition has no socket — must stand down.
   */
  async forceClaim(kind: LeaseKind, connectionId: string): Promise<void> {
    const key = LeaseService.key(kind, connectionId);
    const previous = await this.redis.getset(key, this.podId);
    await this.redis.pexpire(key, this.ttlMs);
    this.held.add(key);
    if (previous && previous !== this.podId) {
      this.logger.log(`Force-claimed ${kind} lease for ${connectionId} from ${previous}`);
    }
  }

  async release(kind: LeaseKind, connectionId: string): Promise<void> {
    const key = LeaseService.key(kind, connectionId);
    this.held.delete(key);
    await (this.redis as never as { leaseRelease(k: string, v: string): Promise<number> }).leaseRelease(
      key,
      this.podId,
    );
  }

  /** Cluster-wide ownership view, for GET /admin/cluster. */
  async ownership(): Promise<LeaseHolder[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', 'cti:lease:*', 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (!keys.length) return [];

    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.get(key).pttl(key);
    const results = (await pipeline.exec()) ?? [];

    return keys.map((key, i) => {
      const { kind, connectionId } = LeaseService.parse(key);
      return {
        kind,
        connectionId,
        podId: (results[i * 2]?.[1] as string) ?? 'unknown',
        ttlMs: (results[i * 2 + 1]?.[1] as number) ?? 0,
      };
    });
  }

  /**
   * Renew every held lease. A renewal that returns 0 means the key expired or
   * was claimed elsewhere while we thought we owned it — the split-brain case
   * that duplicates CRM writes, so listeners stop serving immediately.
   */
  private async renewAll(): Promise<void> {
    if (this.shuttingDown) return;
    for (const key of [...this.held]) {
      try {
        const ok = await (
          this.redis as never as { leaseRenew(k: string, v: string, ttl: number): Promise<number> }
        ).leaseRenew(key, this.podId, this.ttlMs);
        if (ok) continue;
        this.held.delete(key);
        const { kind, connectionId } = LeaseService.parse(key);
        this.logger.warn(`Lost ${kind} lease for ${connectionId} — standing down`);
        for (const listener of this.lostListeners) listener(kind, connectionId);
      } catch (err) {
        // A Redis blip is not proof of lost ownership; keep serving and retry
        // on the next tick. The TTL is the backstop if Redis stays away.
        this.logger.warn(`Lease renew failed for ${key}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Hand ownership back on the way out so a peer picks the connection up in
   * milliseconds rather than waiting out the TTL.
   */
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.renewTimer) clearInterval(this.renewTimer);
    const keys = [...this.held];
    this.held.clear();
    for (const key of keys) {
      const { kind, connectionId } = LeaseService.parse(key);
      try {
        await this.release(kind, connectionId);
      } catch {
        /* shutting down anyway; the TTL will reap it */
      }
    }
  }
}
