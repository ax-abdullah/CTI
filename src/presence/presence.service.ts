import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { AmiMessage } from '../pbx-connector/ami-client';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  CALL_EVENTS,
  CallAnsweredEvent,
  CallEndedEvent,
  CallRingingEvent,
} from '../call-state/normalized-events';
import { TenantRegistryService } from '../tenants/tenant-registry.service';

export type AgentState = 'NOT_INUSE' | 'RINGING' | 'INUSE' | 'UNAVAILABLE';

export interface AgentStateEvent {
  tenantId: string;
  ext: string;
  state: AgentState;
  at: string;
}

export const AGENT_STATE_EVENT = 'agent.state';

/**
 * Agent presence. Two sources, merged:
 * - Derived from our own normalized call lifecycle (portable — works on any
 *   PBX the connector can see): ringing -> RINGING, answered -> INUSE,
 *   ended -> NOT_INUSE.
 * - AMI DeviceStateChange passthrough for device-level reachability
 *   (UNAVAILABLE when a phone unregisters), mapped onto tenant agents.
 * Emits 'agent.state' on the bus (softphone gateway fans it out to the
 * tenant's sockets) and keeps a snapshot for GET /v1/agents/state.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);
  /** Local mirror, used only to suppress no-op transitions cheaply. */
  private readonly states = new Map<string, AgentStateEvent>(); // `${tenant}:${ext}`
  private readonly ttlSec = 24 * 3600;

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly bus: EventEmitter2,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private key(tenantSlug: string): string {
    return `cti:presence:${tenantSlug}`;
  }

  /**
   * Read from Redis, not local memory: presence is derived on whichever pod
   * owns the PBX, but GET /v1/agents/state is answered by whichever pod the
   * request reached. Reading locally would make the answer depend on which
   * replica you happened to hit.
   */
  async snapshot(tenantSlug: string): Promise<AgentStateEvent[]> {
    try {
      const raw = await this.redis.hgetall(this.key(tenantSlug));
      return Object.values(raw).map((v) => JSON.parse(v) as AgentStateEvent);
    } catch (e) {
      this.logger.warn(`presence read failed for ${tenantSlug}: ${(e as Error).message}`);
      return [...this.states.values()].filter((s) => s.tenantId === tenantSlug);
    }
  }

  @OnEvent(CALL_EVENTS.ringing)
  onRinging(event: CallRingingEvent): void {
    if (!event.agentExt) return;
    this.set(event.tenantId, event.agentExt, 'RINGING');
  }

  @OnEvent(CALL_EVENTS.answered)
  onAnswered(event: CallAnsweredEvent): void {
    if (event.agentExt) this.set(event.tenantId, event.agentExt, 'INUSE');
  }

  @OnEvent(CALL_EVENTS.ended)
  onEnded(event: CallEndedEvent): void {
    if (event.agentExt) this.set(event.tenantId, event.agentExt, 'NOT_INUSE');
  }

  @OnEvent('ami.event')
  onAmiEvent({ connectionId, msg }: { connectionId: string; msg: AmiMessage }): void {
    if (msg.Event !== 'DeviceStateChange' || !msg.Device) return;
    const ext = msg.Device.match(/^[^/]+\/(.+)$/)?.[1];
    if (!ext) return;
    const tenant = this.registry.resolveTenantForCall(connectionId, { extensions: [ext] });
    if (!tenant || !tenant.entity.agents?.some((a) => a.ext === ext)) return;

    // Call-derived states are richer while a call is in flight; only
    // reachability changes are taken from the device layer.
    if (msg.State === 'UNAVAILABLE') this.set(tenant.entity.slug, ext, 'UNAVAILABLE');
    else if (msg.State === 'NOT_INUSE' && this.states.get(`${tenant.entity.slug}:${ext}`)?.state === 'UNAVAILABLE') {
      this.set(tenant.entity.slug, ext, 'NOT_INUSE');
    }
  }

  private set(tenantId: string, ext: string, state: AgentState): void {
    const key = `${tenantId}:${ext}`;
    if (this.states.get(key)?.state === state) return;
    const event: AgentStateEvent = { tenantId, ext, state, at: new Date().toISOString() };
    this.states.set(key, event);

    // Write-through so every replica can answer for this agent. Expiry is
    // refreshed on each change; an agent nobody has seen for a day falls out
    // rather than lingering as a stale "available" forever.
    this.redis
      .hset(this.key(tenantId), ext, JSON.stringify(event))
      .then(() => this.redis.expire(this.key(tenantId), this.ttlSec))
      .catch((e) => this.logger.warn(`presence write failed for ${key}: ${(e as Error).message}`));

    this.bus.emit(AGENT_STATE_EVENT, event);
    this.logger.debug(`[${tenantId}] ext ${ext} -> ${state}`);
  }
}
