import { BeforeApplicationShutdown, Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { Redis } from 'ioredis';
import { AmiMessage } from '../pbx-connector/ami-client';
import { REDIS_CLIENT } from '../redis/redis.module';
import { TenantRegistryService, ResolvedTenant } from '../tenants/tenant-registry.service';
import { RecordingsService } from '../recordings/recordings.service';
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

/** JSON-safe projection of a CallRecord for Redis (no Map, Dates, timers). */
interface CallSnapshot {
  callId: string;
  connectionId: string;
  tenantSlug?: string;
  direction?: CallDirection;
  agentExt?: string;
  remoteNumber?: string;
  remoteName?: string;
  callRef?: string;
  recordingPath?: string;
  startedAt: string;
  answeredAt?: string;
  ringingEmitted: boolean;
  answeredEmitted: boolean;
  lastDialStatus?: string;
  channels: TrackedChannel[];
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
  recordingPath?: string;
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
export class CallStateService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(CallStateService.name);
  private readonly calls = new Map<string, CallRecord>();
  private readonly finalizeGraceMs = 1_500;
  private readonly ttlSec = 6 * 3600;

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly recordings: RecordingsService,
    private readonly bus: EventEmitter2,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Cluster-wide read from Redis (the durable source of truth), so /v1/calls
   * and /admin/overview stay correct after a restart and across instances.
   */
  async activeCalls(tenantSlug?: string) {
    const snapshots = await this.scanSnapshots();
    return snapshots
      .filter((s) => !tenantSlug || s.tenantSlug === tenantSlug)
      .map((s) => ({
        callId: s.callId,
        tenant: s.tenantSlug,
        direction: s.direction,
        agentExt: s.agentExt,
        remoteNumber: s.remoteNumber,
        state: s.answeredEmitted ? 'answered' : 'ringing',
        startedAt: s.startedAt,
        channels: s.channels.map((ch) => ch.name),
      }));
  }

  /** Persisted state survives restarts, so pending timers can be dropped. */
  beforeApplicationShutdown(): void {
    for (const call of this.calls.values()) {
      if (call.finalizeTimer) clearTimeout(call.finalizeTimer);
    }
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
    this.persist(call);
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
    this.persist(call);
  }

  private onDialEnd(connectionId: string, msg: AmiMessage): void {
    const call = this.callOf(connectionId, msg);
    if (!call) return;
    call.lastDialStatus = msg.DialStatus;
    if (msg.DialStatus === 'ANSWER') this.markAnswered(call);
    this.persist(call);
  }

  /**
   * CTI_CALL_REF marks a click-to-call we originated (see PbxSupervisor);
   * MIXMONITOR_FILENAME is Asterisk telling us where the recording landed.
   */
  private onVarSet(connectionId: string, msg: AmiMessage): void {
    const call = this.callOf(connectionId, msg);
    if (!call) return;
    if (msg.Variable === 'CTI_CALL_REF') {
      call.callRef = msg.Value;
      call.direction = 'outbound';
    } else if (msg.Variable === 'MIXMONITOR_FILENAME' && msg.Value) {
      call.recordingPath = msg.Value;
    } else {
      return; // uninteresting variable — don't churn Redis
    }
    this.persist(call);
  }

  private markAnswered(call?: CallRecord): void {
    if (!call || call.answeredEmitted) return;
    call.answeredEmitted = true;
    call.answeredAt = new Date();
    this.persist(call);
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
    this.persist(call);

    if (![...call.channels.values()].every((c) => c.hungUp)) return;
    if (call.finalizeTimer) clearTimeout(call.finalizeTimer);
    call.finalizeTimer = setTimeout(() => this.finalize(call), this.finalizeGraceMs);
  }

  private finalize(call: CallRecord): void {
    if (call.endedEmitted) return;
    if (![...call.channels.values()].every((c) => c.hungUp)) return;

    call.endedEmitted = true;
    this.calls.delete(call.key);
    this.forget(call);

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
      recordingUrl: call.recordingPath
        ? this.recordings.signedUrlFor(call.recordingPath)
        : undefined,
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

  // ------------------------------------------------------ Redis persistence

  private redisKey(connectionId: string, callId: string): string {
    return `call:${connectionId}:${callId}`;
  }

  /** Write-through: snapshot captured synchronously, SET fired async. */
  private persist(call: CallRecord): void {
    if (call.endedEmitted) return;
    const json = JSON.stringify(this.toSnapshot(call));
    this.redis
      .set(this.redisKey(call.connectionId, call.callId), json, 'EX', this.ttlSec)
      .catch((e) => this.logger.warn(`persist ${call.key} failed: ${(e as Error).message}`));
  }

  private forget(call: CallRecord): void {
    this.redis
      .del(this.redisKey(call.connectionId, call.callId))
      .catch((e) => this.logger.warn(`forget ${call.key} failed: ${(e as Error).message}`));
  }

  private toSnapshot(call: CallRecord): CallSnapshot {
    return {
      callId: call.callId,
      connectionId: call.connectionId,
      tenantSlug: call.tenant?.entity.slug,
      direction: call.direction,
      agentExt: call.agentExt,
      remoteNumber: call.remoteNumber,
      remoteName: call.remoteName,
      callRef: call.callRef,
      recordingPath: call.recordingPath,
      startedAt: call.startedAt.toISOString(),
      answeredAt: call.answeredAt?.toISOString(),
      ringingEmitted: call.ringingEmitted,
      answeredEmitted: call.answeredEmitted,
      lastDialStatus: call.lastDialStatus,
      channels: [...call.channels.values()],
    };
  }

  private fromSnapshot(snap: CallSnapshot): CallRecord {
    return {
      key: `${snap.connectionId}:${snap.callId}`,
      callId: snap.callId,
      connectionId: snap.connectionId,
      tenant: snap.tenantSlug ? this.registry.tenantBySlug(snap.tenantSlug) : undefined,
      channels: new Map(snap.channels.map((c) => [c.uniqueid, c])),
      direction: snap.direction,
      agentExt: snap.agentExt,
      remoteNumber: snap.remoteNumber,
      remoteName: snap.remoteName,
      callRef: snap.callRef,
      recordingPath: snap.recordingPath,
      startedAt: new Date(snap.startedAt),
      answeredAt: snap.answeredAt ? new Date(snap.answeredAt) : undefined,
      ringingEmitted: snap.ringingEmitted,
      answeredEmitted: snap.answeredEmitted,
      endedEmitted: false,
    };
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    return keys;
  }

  private async scanSnapshots(pattern = 'call:*'): Promise<CallSnapshot[]> {
    const keys = await this.scanKeys(pattern);
    if (!keys.length) return [];
    const values = await this.redis.mget(keys);
    const out: CallSnapshot[] = [];
    for (const v of values) {
      if (!v) continue;
      try {
        out.push(JSON.parse(v) as CallSnapshot);
      } catch {
        /* skip corrupt entry */
      }
    }
    return out;
  }

  // ---------------------------------------------------- resync support (§2)

  /** Rehydrate persisted calls for a connection into memory; returns them. */
  async loadPersisted(connectionId: string): Promise<CallRecord[]> {
    const snaps = await this.scanSnapshots(`call:${connectionId}:*`);
    const records: CallRecord[] = [];
    for (const snap of snaps) {
      const record = this.fromSnapshot(snap);
      this.calls.set(record.key, record);
      records.push(record);
    }
    return records;
  }

  has(connectionId: string, callId: string): boolean {
    return this.calls.has(`${connectionId}:${callId}`);
  }

  /** Force a terminal call.ended now (a call the PBX no longer shows live). */
  finalizeNow(connectionId: string, callId: string): void {
    const call = this.calls.get(`${connectionId}:${callId}`);
    if (!call) return;
    for (const ch of call.channels.values()) ch.hungUp = true;
    if (call.finalizeTimer) clearTimeout(call.finalizeTimer);
    this.finalize(call);
  }

  /** Mark a kept call's departed legs hung up; finalize if all are gone. */
  reconcileChannels(connectionId: string, callId: string, liveUniqueids: Set<string>): void {
    const call = this.calls.get(`${connectionId}:${callId}`);
    if (!call) return;
    for (const ch of call.channels.values()) {
      if (!liveUniqueids.has(ch.uniqueid)) ch.hungUp = true;
    }
    if ([...call.channels.values()].every((c) => c.hungUp)) this.finalizeNow(connectionId, callId);
    else this.persist(call);
  }

  /**
   * Create a minimal record for a call the PBX shows live but we never
   * persisted (started during downtime). We don't re-emit ringing/answered
   * for a call already in progress — we only ensure its eventual Hangup
   * produces a call.ended for CRM logging.
   */
  synthesize(
    connectionId: string,
    callId: string,
    channels: TrackedChannel[],
    opts: { answered: boolean; startedAt: Date },
  ): void {
    const key = `${connectionId}:${callId}`;
    if (this.calls.has(key)) return;
    const call: CallRecord = {
      key,
      callId,
      connectionId,
      channels: new Map(channels.map((c) => [c.uniqueid, c])),
      startedAt: opts.startedAt,
      answeredAt: opts.answered ? new Date() : undefined,
      ringingEmitted: true,
      answeredEmitted: opts.answered,
      endedEmitted: false,
    };
    this.tryResolveTenant(call);
    this.calls.set(key, call);
    this.persist(call);
  }
}
