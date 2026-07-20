import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { AmiMessage } from '../pbx-connector/ami-client';
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
  private readonly states = new Map<string, AgentStateEvent>(); // `${tenant}:${ext}`
  private readonly callAgents = new Map<string, { tenantId: string; ext: string }>();

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly bus: EventEmitter2,
  ) {}

  snapshot(tenantSlug: string): AgentStateEvent[] {
    return [...this.states.values()].filter((s) => s.tenantId === tenantSlug);
  }

  @OnEvent(CALL_EVENTS.ringing)
  onRinging(event: CallRingingEvent): void {
    if (!event.agentExt) return;
    this.callAgents.set(event.callId, { tenantId: event.tenantId, ext: event.agentExt });
    this.set(event.tenantId, event.agentExt, 'RINGING');
  }

  @OnEvent(CALL_EVENTS.answered)
  onAnswered(event: CallAnsweredEvent): void {
    const route = this.callAgents.get(event.callId);
    if (route) this.set(route.tenantId, route.ext, 'INUSE');
  }

  @OnEvent(CALL_EVENTS.ended)
  onEnded(event: CallEndedEvent): void {
    const route = this.callAgents.get(event.callId);
    this.callAgents.delete(event.callId);
    if (route) this.set(route.tenantId, route.ext, 'NOT_INUSE');
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
    this.bus.emit(AGENT_STATE_EVENT, event);
    this.logger.debug(`[${tenantId}] ext ${ext} -> ${state}`);
  }
}
