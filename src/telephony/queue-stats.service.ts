import { Injectable } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { AmiMessage } from '../pbx-connector/ami-client';

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

export const QUEUE_STATS_EVENT = 'queue.stats';

/**
 * Live queue/ACD statistics for a wallboard, aggregated from AMI app_queue
 * events. Keyed by (connectionId, queue). Emits `queue.stats` on change so
 * the softphone/supervisor WebSocket can stream a wallboard; snapshot() backs
 * GET /v1/queues.
 */
@Injectable()
export class QueueStatsService {
  private readonly stats = new Map<string, QueueStat>();

  constructor(private readonly bus: EventEmitter2) {}

  @OnEvent('ami.event')
  onAmiEvent({ connectionId, msg }: { connectionId: string; msg: AmiMessage }): void {
    if (!msg.Queue) return;
    const stat = this.get(connectionId, msg.Queue);
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
    this.bus.emit(QUEUE_STATS_EVENT, this.view(stat));
  }

  /** Wallboard snapshot, optionally limited to a set of connections. */
  snapshot(connectionIds?: string[]) {
    return [...this.stats.values()]
      .filter((s) => !connectionIds || connectionIds.includes(s.connectionId))
      .map((s) => this.view(s));
  }

  private get(connectionId: string, queue: string): QueueStat {
    const key = `${connectionId}:${queue}`;
    let stat = this.stats.get(key);
    if (!stat) {
      stat = { connectionId, queue, waiting: 0, answered: 0, abandoned: 0, totalHoldSec: 0, totalTalkSec: 0, members: new Map() };
      this.stats.set(key, stat);
    }
    return stat;
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
