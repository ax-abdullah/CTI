import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CallStateService } from '../call-state/call-state.service';
import { AmiMessage } from './ami-client';
import { PbxSupervisorService } from './pbx-supervisor.service';

export interface LiveChannel {
  uniqueid: string;
  linkedid: string;
  channel: string;
  state: string; // ChannelStateDesc
  callerIdNum?: string;
  context?: string;
  durationSec: number;
}

export interface ReconcilePlan {
  finalize: string[]; // persisted Linkedids the PBX no longer shows → emit call.ended
  keep: string[]; // persisted Linkedids still live → hydrate, prune dead legs
  synthesize: string[]; // live Linkedids we never persisted → create minimal record
}

/**
 * Pure reconciliation between what we persisted and what the PBX actually
 * has live. No I/O — trivially unit-testable.
 */
export function reconcile(persistedLinkedids: string[], live: LiveChannel[]): ReconcilePlan {
  const liveLinkedids = new Set(live.map((c) => c.linkedid));
  const persistedSet = new Set(persistedLinkedids);
  return {
    finalize: persistedLinkedids.filter((id) => !liveLinkedids.has(id)),
    keep: persistedLinkedids.filter((id) => liveLinkedids.has(id)),
    synthesize: [...liveLinkedids].filter((id) => !persistedSet.has(id)),
  };
}

/** "01:23:45" → seconds. */
function parseDuration(hms?: string): number {
  if (!hms) return 0;
  const parts = hms.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * On every (re)connect, reconcile persisted call-state against the PBX's
 * live channels (ADR-0003's designated mitigation): finalize calls that
 * ended during downtime so the CRM still logs them, keep the ones still
 * live, and synthesize records for calls that started while we were down so
 * their eventual Hangup still emits call.ended.
 */
@Injectable()
export class ResyncService {
  private readonly logger = new Logger(ResyncService.name);

  constructor(
    private readonly callState: CallStateService,
    private readonly supervisor: PbxSupervisorService,
  ) {}

  @OnEvent('pbx.connected')
  async onConnected({ connectionId }: { connectionId: string }): Promise<void> {
    try {
      await this.resync(connectionId);
    } catch (err) {
      this.logger.warn(`resync for ${connectionId} failed: ${(err as Error).message}`);
    }
  }

  async resync(connectionId: string): Promise<void> {
    const persisted = await this.callState.loadPersisted(connectionId);
    const live = this.parseChannels(await this.supervisor.showChannels(connectionId));
    const plan = reconcile(
      persisted.map((r) => r.callId),
      live,
    );

    for (const callId of plan.finalize) this.callState.finalizeNow(connectionId, callId);

    const liveByLinkedid = new Map<string, LiveChannel[]>();
    for (const c of live) {
      (liveByLinkedid.get(c.linkedid) ?? liveByLinkedid.set(c.linkedid, []).get(c.linkedid)!).push(c);
    }

    for (const callId of plan.keep) {
      const uniqueids = new Set((liveByLinkedid.get(callId) ?? []).map((c) => c.uniqueid));
      this.callState.reconcileChannels(connectionId, callId, uniqueids);
    }

    for (const callId of plan.synthesize) {
      const chans = liveByLinkedid.get(callId) ?? [];
      const maxDuration = Math.max(0, ...chans.map((c) => c.durationSec));
      this.callState.synthesize(
        connectionId,
        callId,
        chans.map((c) => ({
          uniqueid: c.uniqueid,
          name: c.channel,
          callerIdNum: c.callerIdNum && c.callerIdNum !== '<unknown>' ? c.callerIdNum : undefined,
          context: c.context,
          isLocal: c.channel.startsWith('Local/'),
          endpoint: c.channel.match(/^[^/]+\/([^@-]+)/)?.[1],
          hungUp: false,
        })),
        { answered: chans.some((c) => c.state === 'Up'), startedAt: new Date(Date.now() - maxDuration * 1000) },
      );
    }

    if (plan.finalize.length || plan.keep.length || plan.synthesize.length) {
      this.logger.log(
        `resync ${connectionId}: finalized ${plan.finalize.length}, kept ${plan.keep.length}, synthesized ${plan.synthesize.length}`,
      );
    }
  }

  private parseChannels(events: AmiMessage[]): LiveChannel[] {
    return events
      .filter((e) => e.Event === 'CoreShowChannel' && e.Linkedid && e.Uniqueid && e.Channel)
      .map((e) => ({
        uniqueid: e.Uniqueid,
        linkedid: e.Linkedid,
        channel: e.Channel,
        state: e.ChannelStateDesc ?? '',
        callerIdNum: e.CallerIDNum,
        context: e.Context,
        durationSec: parseDuration(e.Duration),
      }));
  }
}
