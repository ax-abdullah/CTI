import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { AmiMessage } from '../pbx-connector/ami-client';
import { TenantRegistryService, ResolvedTenant } from '../tenants/tenant-registry.service';
import { CALL_EVENTS, CallDirection, CallEndedEvent } from './normalized-events';

interface TrackedChannel {
  uniqueid: string;
  name: string;
  callerIdNum?: string;
  context?: string;
  isLocal: boolean;
  endpoint?: string;
  hungUp: boolean;
}

interface CallRecord {
  key: string; // `${connectionId}:${linkedid}`
  callId: string; // Linkedid
  connectionId: string;
  tenant?: ResolvedTenant;
  channels: Map<string, TrackedChannel>;
  direction?: CallDirection;
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
 * Correlates channel-centric AMI events into call-centric state, keyed by
 * (connectionId, Linkedid), and emits the normalized call.* vocabulary.
 *
 * Tenant routing (shared-PBX case): a connection may host several tenants
 * partitioned by dialplan context and extension range. Each call is
 * assigned to a tenant via TenantRegistryService.resolveTenantForCall using
 * channel contexts and endpoints as hints; events are held back until the
 * owning tenant is known, and calls that match no tenant are dropped at
 * finalize (never delivered cross-tenant).
 */
@Injectable()
export class CallStateService {
  private readonly logger = new Logger(CallStateService.name);
  private readonly calls = new Map<string, CallRecord>();
  private readonly finalizeGraceMs = 1_500;

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly bus: EventEmitter2,
  ) {}

  activeCalls(tenantSlug?: string) {
    return [...this.calls.values()]
      .filter((c) => !tenantSlug || c.tenant?.entity.slug === tenantSlug)
      .map((c) => ({
        callId: c.callId,
        tenant: c.tenant?.entity.slug,
        direction: c.direction,
        agentExt: c.agentExt,
        remoteNumber: c.remoteNumber,
        state: c.answeredEmitted ? 'answered' : 'ringing',
        startedAt: c.startedAt.toISOString(),
        channels: [...c.channels.values()].map((ch) => ch.name),
      }));
  }

  @OnEvent('ami.event')
  handleAmiEvent({ connectionId, msg }: { connectionId: string; msg: AmiMessage }): void {
    switch (msg.Event) {
      case 'Newchannel':
        return this.onNewchannel(connectionId, msg);
      case 'DialBegin':
        return this.onDialBegin(connectionId, msg);
      case 'DialEnd':
        return this.onDialEnd(connectionId, msg);
      case 'BridgeEnter':
        return this.markAnswered(this.callOf(connectionId, msg));
      case 'Newstate':
        if (msg.ChannelStateDesc === 'Up') this.markAnswered(this.callOf(connectionId, msg));
        return;
      case 'VarSet':
        return this.onVarSet(connectionId, msg);
      case 'Hangup':
        return this.onHangup(connectionId, msg);
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- events

  private onNewchannel(connectionId: string, msg: AmiMessage): void {
    if (!msg.Linkedid || !msg.Uniqueid || !msg.Channel) return;
    const key = `${connectionId}:${msg.Linkedid}`;

    let call = this.calls.get(key);
    if (!call) {
      call = {
        key,
        callId: msg.Linkedid,
        connectionId,
        channels: new Map(),
        startedAt: new Date(),
        ringingEmitted: false,
        answeredEmitted: false,
        endedEmitted: false,
      };
      this.calls.set(key, call);
    }
    call.channels.set(msg.Uniqueid, this.trackChannel(msg));
    this.tryResolveTenant(call);
    this.tryEmitRinging(call);
  }

  private onDialBegin(connectionId: string, msg: AmiMessage): void {
    const call = this.callOf(connectionId, msg);
    if (!call) return;
    const destExt = this.endpointOf(msg.DestChannel ?? '');
    if (destExt && call.tenant?.extensionRegex.test(destExt)) {
      call.agentExt ??= destExt;
    } else if (msg.DialString) {
      call.remoteNumber ??= msg.DialString;
    }
    this.tryResolveTenant(call);
    this.tryEmitRinging(call);
  }

  private onDialEnd(connectionId: string, msg: AmiMessage): void {
    const call = this.callOf(connectionId, msg);
    if (!call) return;
    call.lastDialStatus = msg.DialStatus;
    if (msg.DialStatus === 'ANSWER') this.markAnswered(call);
  }

  /** CTI_CALL_REF marks a click-to-call we originated (see PbxSupervisor). */
  private onVarSet(connectionId: string, msg: AmiMessage): void {
    if (msg.Variable !== 'CTI_CALL_REF') return;
    const call = this.callOf(connectionId, msg);
    if (!call) return;
    call.callRef = msg.Value;
    call.direction = 'outbound';
  }

  private markAnswered(call?: CallRecord): void {
    if (!call || call.answeredEmitted) return;
    call.answeredEmitted = true;
    call.answeredAt = new Date();
    if (!call.tenant) return;
    this.bus.emit(CALL_EVENTS.answered, {
      callId: call.callId,
      tenantId: call.tenant.entity.slug,
      answeredAt: call.answeredAt.toISOString(),
    });
  }

  private onHangup(connectionId: string, msg: AmiMessage): void {
    const call = this.callOf(connectionId, msg);
    if (!call) return;
    const channel = msg.Uniqueid ? call.channels.get(msg.Uniqueid) : undefined;
    if (channel) channel.hungUp = true;

    if (![...call.channels.values()].every((c) => c.hungUp)) return;
    if (call.finalizeTimer) clearTimeout(call.finalizeTimer);
    call.finalizeTimer = setTimeout(() => this.finalize(call), this.finalizeGraceMs);
  }

  private finalize(call: CallRecord): void {
    if (call.endedEmitted) return;
    if (![...call.channels.values()].every((c) => c.hungUp)) return;

    call.endedEmitted = true;
    this.calls.delete(call.key);

    if (!call.tenant) {
      this.logger.warn(`Call ${call.callId} matched no tenant on connection ${call.connectionId}; dropped`);
      return;
    }

    const endedAt = new Date();
    const event: CallEndedEvent = {
      callId: call.callId,
      tenantId: call.tenant.entity.slug,
      direction: call.direction ?? 'internal',
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
      `[${call.tenant.entity.slug}] call ${call.callId} ended: ${event.disposition}, ${event.durationSec}s`,
    );
  }

  // ---------------------------------------------------------------- helpers

  private callOf(connectionId: string, msg: AmiMessage): CallRecord | undefined {
    return msg.Linkedid ? this.calls.get(`${connectionId}:${msg.Linkedid}`) : undefined;
  }

  private tryResolveTenant(call: CallRecord): void {
    if (call.tenant) return;
    const channels = [...call.channels.values()];
    for (const channel of channels) {
      const tenant = this.registry.resolveTenantForCall(call.connectionId, {
        context: channel.context,
        extensions: channels.flatMap((c) => (c.endpoint ? [c.endpoint] : [])),
      });
      if (tenant) {
        call.tenant = tenant;
        return;
      }
    }
  }

  /**
   * Ringing is emitted once, as soon as the owning tenant is known — later
   * AMI events (DialBegin) may enrich party info, but the pop must be early.
   */
  private tryEmitRinging(call: CallRecord): void {
    if (call.ringingEmitted || !call.tenant) return;
    this.resolveParties(call);
    call.direction ??= this.detectDirection(call);
    call.ringingEmitted = true;
    this.bus.emit(CALL_EVENTS.ringing, {
      callId: call.callId,
      tenantId: call.tenant.entity.slug,
      direction: call.direction,
      agentExt: call.agentExt,
      remoteNumber: call.remoteNumber,
      remoteName: call.remoteName,
      startedAt: call.startedAt.toISOString(),
    });
    // A late answer may have been observed before the tenant resolved.
    if (call.answeredEmitted && call.answeredAt) {
      this.bus.emit(CALL_EVENTS.answered, {
        callId: call.callId,
        tenantId: call.tenant.entity.slug,
        answeredAt: call.answeredAt.toISOString(),
      });
    }
  }

  private trackChannel(msg: AmiMessage): TrackedChannel {
    const name = msg.Channel!;
    return {
      uniqueid: msg.Uniqueid!,
      name,
      callerIdNum: msg.CallerIDNum && msg.CallerIDNum !== '<unknown>' ? msg.CallerIDNum : undefined,
      context: msg.Context,
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

  private detectDirection(call: CallRecord): CallDirection {
    const regex = call.tenant!.extensionRegex;
    const first = [...call.channels.values()][0];
    if (!first) return 'internal';
    const fromExtension =
      (first.callerIdNum && regex.test(first.callerIdNum)) ||
      (first.endpoint && !first.isLocal && regex.test(first.endpoint));
    return fromExtension ? 'outbound' : 'inbound';
  }

  private resolveParties(call: CallRecord): void {
    const regex = call.tenant!.extensionRegex;
    const channels = [...call.channels.values()];
    const ranked = [...channels.filter((c) => !c.isLocal), ...channels.filter((c) => c.isLocal)];
    for (const ch of ranked) {
      if (!call.agentExt && ch.endpoint && regex.test(ch.endpoint)) call.agentExt = ch.endpoint;
      if (!call.remoteNumber && ch.callerIdNum && !regex.test(ch.callerIdNum)) {
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
