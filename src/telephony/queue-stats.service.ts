import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { Redis } from 'ioredis';
import { AmiMessage } from '../pbx-connector/ami-client';
import { REDIS_CLIENT } from '../redis/redis.module';

interface QueueStat {
  connectionId: string;
  queue: string;
  waiting: number;
  answered: number;
  abandoned: number;
  totalHoldSec: number;
  totalTalkSec: number;
  members: Map<string, { available: boolean }>;
}

/** JSON-safe projection of a QueueStat for Redis (Map → object). */
interface QueueStatSnapshot extends Omit<QueueStat, 'members'> {
  members: Record<string, { available: boolean }>;
}

export const QUEUE_STATS_EVENT = 'queue.stats';

/**
 * Live queue/ACD statistics for a wallboard, aggregated from AMI app_queue
 * events. Keyed by (connectionId, queue). Emits `queue.stats` on change so
 * the softphone/supervisor WebSocket can stream a wallboard; snapshot() backs
 * GET /v1/queues.
 *
 * Aggregation happens in memory on the pod that owns the connection — it is
 * the only pod receiving that PBX's events — but the totals are written
 * through to Redis and hydrated back on first touch. Two reasons (ADR-0012):
 * GET /v1/queues is answered by whichever replica the request reaches, and
 * counters would otherwise reset to zero whenever ownership moved, making the
 * wallboard flicker through every rolling deploy.
 */
@Injectable()
export class QueueStatsService {
  private readonly logger = new Logger(QueueStatsService.name);
  private readonly stats = new Map<string, QueueStat>();
  private readonly ttlSec = 24 * 3600;

  constructor(
    private readonly bus: EventEmitter2,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private static key(connectionId: string, queue: string): string {
    return `cti:qstats:${connectionId}:${queue}`;
  }

  @OnEvent('ami.event')
  async onAmiEvent({ connectionId, msg }: { connectionId: string; msg: AmiMessage }): Promise<void> {
    if (!msg.Queue) return;
    const stat = await this.get(connectionId, msg.Queue);
    switch (msg.Event) {
      case 'QueueCallerJoin':
        stat.waiting = this.count(msg.Count, stat.waiting + 1);
        break;
      case 'QueueCallerLeave':
        stat.waiting = this.count(msg.Count, Math.max(0, stat.waiting - 1));
        break;
      case 'QueueCallerAbandon':
        stat.abandoned += 1;
        stat.waiting = this.count(msg.Count, Math.max(0, stat.waiting - 1));
        break;
      case 'AgentConnect':
        stat.answered += 1;
        stat.totalHoldSec += Number(msg.HoldTime ?? 0);
        stat.waiting = Math.max(0, stat.waiting - 1);
        break;
      case 'AgentComplete':
        stat.totalTalkSec += Number(msg.TalkTime ?? 0);
        break;
      case 'QueueMemberStatus':
      case 'QueueMemberAdded':
        if (msg.MemberName) {
          stat.members.set(msg.MemberName, { available: msg.Status === '1' && msg.Paused !== '1' });
        }
        break;
      case 'QueueMemberRemoved':
        if (msg.MemberName) stat.members.delete(msg.MemberName);
        break;
      default:
        return;
    }
    this.persist(stat);
    this.bus.emit(QUEUE_STATS_EVENT, this.view(stat));
  }

  /** Wallboard snapshot, optionally limited to a set of connections. */
  async snapshot(connectionIds?: string[]) {
    const snaps = await this.scan();
    return snaps
      .filter((s) => !connectionIds || connectionIds.includes(s.connectionId))
      .map((s) => this.view(this.fromSnapshot(s)));
  }

  private async get(connectionId: string, queue: string): Promise<QueueStat> {
    const key = `${connectionId}:${queue}`;
    const cached = this.stats.get(key);
    if (cached) return cached;

    // Not seen by this process yet — it may still have history from the pod
    // that owned this connection before us.
    let stat: QueueStat | undefined;
    try {
      const raw = await this.redis.get(QueueStatsService.key(connectionId, queue));
      if (raw) stat = this.fromSnapshot(JSON.parse(raw) as QueueStatSnapshot);
    } catch (e) {
      this.logger.warn(`qstats hydrate failed for ${key}: ${(e as Error).message}`);
    }
    stat ??= {
      connectionId,
      queue,
      waiting: 0,
      answered: 0,
      abandoned: 0,
      totalHoldSec: 0,
      totalTalkSec: 0,
      members: new Map(),
    };
    this.stats.set(key, stat);
    return stat;
  }

  private persist(stat: QueueStat): void {
    const snapshot: QueueStatSnapshot = {
      ...stat,
      members: Object.fromEntries(stat.members),
    };
    this.redis
      .set(
        QueueStatsService.key(stat.connectionId, stat.queue),
        JSON.stringify(snapshot),
        'EX',
        this.ttlSec,
      )
      .catch((e) => this.logger.warn(`qstats persist failed: ${(e as Error).message}`));
  }

  private fromSnapshot(s: QueueStatSnapshot): QueueStat {
    return { ...s, members: new Map(Object.entries(s.members ?? {})) };
  }

  private async scan(): Promise<QueueStatSnapshot[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', 'cti:qstats:*', 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (!keys.length) return [];

    const raw = await this.redis.mget(keys);
    return raw
      .filter((v): v is string => !!v)
      .map((v) => JSON.parse(v) as QueueStatSnapshot);
  }

  private count(raw: string | undefined, fallback: number): number {
    const n = Number(raw);
    return Number.isFinite(n) && raw !== undefined ? n : fallback;
  }

  private view(s: QueueStat) {
    const members = [...s.members.values()];
    return {
      connectionId: s.connectionId,
      queue: s.queue,
      waiting: s.waiting,
      answered: s.answered,
      abandoned: s.abandoned,
      membersTotal: members.length,
      membersAvailable: members.filter((m) => m.available).length,
      avgHoldSec: s.answered ? Math.round(s.totalHoldSec / s.answered) : 0,
      avgTalkSec: s.answered ? Math.round(s.totalTalkSec / s.answered) : 0,
    };
  }
}
