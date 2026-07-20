import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { AmiMessage } from '../pbx-connector/ami-client';
import {
  CALL_EVENTS,
  CallDirection,
  CallEndedEvent,
} from './normalized-events';

interface TrackedChannel {
  uniqueid: string;
  name: string;
  callerIdNum?: string;
  isLocal: boolean;
  endpoint?: string; // "1001" from "PJSIP/1001-0000002a" or "Local/1001@ctx-..."
  hungUp: boolean;
}

interface CallRecord {
  callId: string; // Linkedid
  tenantId: string;
  channels: Map<string, TrackedChannel>;
  direction: CallDirection;
  agentExt?: string;
  remoteNumber?: string;
  remoteName?: string;
  callRef?: string;
  startedAt: Date;
  answeredAt?: Date;
  ringingEmitted: boolean;
  answeredEmitted: boolean;
  endedEmitted: boolean;
  lastDialStatus?: string;
  finalizeTimer?: NodeJS.Timeout;
}

/**
 * Correlates the channel-centric AMI event stream into call-centric state,
 * keyed by Linkedid, and emits the normalized call.* vocabulary.
 *
 * Correlation rules (see cti-architecture.md §3):
 * - Linkedid groups all legs of one call; it is our callId.
 * - Local/ channels are tracked for lifecycle but never preferred for party
 *   resolution (FreePBX uses them heavily for follow-me/queues).
 * - answered := DialEnd(ANSWER) | BridgeEnter | first Newstate Up.
 * - ended := all tracked legs hung up, finalized after a short grace period
 *   so late Cdr/Hangup stragglers are absorbed.
 *
 * Phase 1 keeps state in-memory; Phase 2 moves it to Redis with TTL so a
 * restart doesn't leak in-flight calls (plus CoreShowChannels resync).
 */
@Injectable()
export class CallStateService {
  private readonly logger = new Logger(CallStateService.name);
  private readonly calls = new Map<string, CallRecord>();
  private readonly extensionPattern: RegExp;
  private readonly finalizeGraceMs = 1_500;

  constructor(
    private readonly config: ConfigService,
    private readonly bus: EventEmitter2,
  ) {
    this.extensionPattern = new RegExp(this.config.get('EXTENSION_PATTERN', '^\\d{3,5}$'));
  }

  /** Snapshot of in-flight calls, for GET /v1/calls and debugging. */
  activeCalls() {
    return [...this.calls.values()].map((c) => ({
      callId: c.callId,
      direction: c.direction,
      agentExt: c.agentExt,
      remoteNumber: c.remoteNumber,
      state: c.answeredEmitted ? 'answered' : 'ringing',
      startedAt: c.startedAt.toISOString(),
      channels: [...c.channels.values()].map((ch) => ch.name),
    }));
  }

  @OnEvent('ami.event')
  handleAmiEvent({ tenantId, msg }: { tenantId: string; msg: AmiMessage }): void {
    switch (msg.Event) {
      case 'Newchannel':
        return this.onNewchannel(tenantId, msg);
      case 'DialBegin':
        return this.onDialBegin(msg);
      case 'DialEnd':
        return this.onDialEnd(msg);
      case 'BridgeEnter':
        return this.markAnswered(msg.Linkedid);
      case 'Newstate':
        if (msg.ChannelStateDesc === 'Up') this.markAnswered(msg.Linkedid);
        return;
      case 'VarSet':
        return this.onVarSet(msg);
      case 'Hangup':
        return this.onHangup(msg);
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- events

  private onNewchannel(tenantId: string, msg: AmiMessage): void {
    const linkedid = msg.Linkedid;
    if (!linkedid || !msg.Uniqueid || !msg.Channel) return;

    let call = this.calls.get(linkedid);
    const channel = this.trackChannel(msg);

    if (!call) {
      call = {
        callId: linkedid,
        tenantId,
        channels: new Map(),
        direction: this.detectDirection(channel),
        startedAt: new Date(),
        ringingEmitted: false,
        answeredEmitted: false,
        endedEmitted: false,
      };
      this.calls.set(linkedid, call);
    }
    call.channels.set(channel.uniqueid, channel);
    this.resolveParties(call);

    if (!call.ringingEmitted) {
      call.ringingEmitted = true;
      this.bus.emit(CALL_EVENTS.ringing, {
        callId: call.callId,
        tenantId: call.tenantId,
        direction: call.direction,
        agentExt: call.agentExt,
        remoteNumber: call.remoteNumber,
        remoteName: call.remoteName,
        startedAt: call.startedAt.toISOString(),
      });
    }
  }

  private onDialBegin(msg: AmiMessage): void {
    const call = msg.Linkedid ? this.calls.get(msg.Linkedid) : undefined;
    if (!call) return;
    // The dialed destination is the best signal for which agent is ringing
    // on an inbound call (and for the remote party on an outbound one).
    const destExt = this.endpointOf(msg.DestChannel ?? '');
    if (destExt && this.extensionPattern.test(destExt)) {
      call.agentExt ??= destExt;
    } else if (msg.DialString) {
      call.remoteNumber ??= msg.DialString;
    }
  }

  private onDialEnd(msg: AmiMessage): void {
    const call = msg.Linkedid ? this.calls.get(msg.Linkedid) : undefined;
    if (!call) return;
    call.lastDialStatus = msg.DialStatus;
    if (msg.DialStatus === 'ANSWER') this.markAnswered(msg.Linkedid);
  }

  private markAnswered(linkedid?: string): void {
    const call = linkedid ? this.calls.get(linkedid) : undefined;
    if (!call || call.answeredEmitted) return;
    call.answeredEmitted = true;
    call.answeredAt = new Date();
    this.bus.emit(CALL_EVENTS.answered, {
      callId: call.callId,
      tenantId: call.tenantId,
      answeredAt: call.answeredAt.toISOString(),
    });
  }

  /**
   * CTI_CALL_REF is set by our own Originate action; seeing it proves this
   * call is a click-to-call we initiated — tie it to the API's callRef and
   * pin the direction, which channel heuristics get wrong for Local legs.
   */
  private onVarSet(msg: AmiMessage): void {
    if (msg.Variable !== 'CTI_CALL_REF') return;
    const call = msg.Linkedid ? this.calls.get(msg.Linkedid) : undefined;
    if (!call) return;
    call.callRef = msg.Value;
    call.direction = 'outbound';
  }

  private onHangup(msg: AmiMessage): void {
    const call = msg.Linkedid ? this.calls.get(msg.Linkedid) : undefined;
    if (!call) return;
    const channel = msg.Uniqueid ? call.channels.get(msg.Uniqueid) : undefined;
    if (channel) channel.hungUp = true;

    const allDown = [...call.channels.values()].every((c) => c.hungUp);
    if (!allDown) return;

    // Grace period: another leg may still appear (transfers), and Cdr events
    // can trail the final Hangup. Reset the timer on every qualifying Hangup.
    if (call.finalizeTimer) clearTimeout(call.finalizeTimer);
    call.finalizeTimer = setTimeout(() => this.finalize(call), this.finalizeGraceMs);
  }

  private finalize(call: CallRecord): void {
    if (call.endedEmitted) return;
    const stillDown = [...call.channels.values()].every((c) => c.hungUp);
    if (!stillDown) return; // a new leg joined during the grace period

    call.endedEmitted = true;
    this.calls.delete(call.callId);

    const endedAt = new Date();
    const event: CallEndedEvent = {
      callId: call.callId,
      tenantId: call.tenantId,
      direction: call.direction,
      agentExt: call.agentExt,
      remoteNumber: call.remoteNumber,
      disposition: this.disposition(call),
      durationSec: Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000),
      billsecSec: call.answeredAt
        ? Math.round((endedAt.getTime() - call.answeredAt.getTime()) / 1000)
        : 0,
      startedAt: call.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      callRef: call.callRef,
    };
    this.bus.emit(CALL_EVENTS.ended, event);
    this.logger.log(
      `Call ${call.callId} ended: ${event.disposition}, ${event.durationSec}s (billsec ${event.billsecSec}s)`,
    );
  }

  // ---------------------------------------------------------------- helpers

  private trackChannel(msg: AmiMessage): TrackedChannel {
    const name = msg.Channel!;
    return {
      uniqueid: msg.Uniqueid!,
      name,
      callerIdNum: msg.CallerIDNum && msg.CallerIDNum !== '<unknown>' ? msg.CallerIDNum : undefined,
      isLocal: name.startsWith('Local/'),
      endpoint: this.endpointOf(name),
      hungUp: false,
    };
  }

  /** "PJSIP/1001-0000002a" -> "1001"; "Local/1000@ctx-00000001;2" -> "1000". */
  private endpointOf(channelName: string): string | undefined {
    const m = channelName.match(/^[^/]+\/([^@-]+)/);
    return m?.[1];
  }

  private detectDirection(first: TrackedChannel): CallDirection {
    const fromExtension =
      (first.callerIdNum && this.extensionPattern.test(first.callerIdNum)) ||
      (first.endpoint && !first.isLocal && this.extensionPattern.test(first.endpoint));
    return fromExtension ? 'outbound' : 'inbound';
  }

  /**
   * Prefer real (non-Local) channels when resolving who the agent and the
   * remote party are; fall back to Local legs so lab/Local-only calls still
   * produce usable events.
   */
  private resolveParties(call: CallRecord): void {
    const channels = [...call.channels.values()];
    const ranked = [...channels.filter((c) => !c.isLocal), ...channels.filter((c) => c.isLocal)];
    for (const ch of ranked) {
      if (!call.agentExt && ch.endpoint && this.extensionPattern.test(ch.endpoint)) {
        call.agentExt = ch.endpoint;
      }
      if (!call.remoteNumber && ch.callerIdNum && !this.extensionPattern.test(ch.callerIdNum)) {
        call.remoteNumber = ch.callerIdNum;
      }
    }
  }

  private disposition(call: CallRecord): CallEndedEvent['disposition'] {
    if (call.answeredEmitted) return 'ANSWERED';
    if (call.lastDialStatus === 'BUSY') return 'BUSY';
    if (call.lastDialStatus === 'NOANSWER' || call.lastDialStatus === 'CANCEL') return 'NO ANSWER';
    return 'FAILED';
  }
}
