import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantRegistryService, ResolvedTenant } from '../../tenants/tenant-registry.service';
import { CALL_EVENTS } from '../../call-state/normalized-events';
import { AriClient, AriClientOptions, AriEvent } from './ari-client';
import { ResolvedContact, RoutingService } from './routing.service';

export interface AriConnectionTarget extends AriClientOptions {
  connectionId: string;
  name: string;
}

/** Pluggable caller lookup (a real CRM call); default returns null (unknown). */
export type ContactResolver = (number: string, tenant: ResolvedTenant) => Promise<ResolvedContact | null>;

interface AriCall {
  channelId: string;
  startedAt: Date;
  answeredAt?: Date;
  tenant?: ResolvedTenant;
  remoteNumber?: string;
  ended: boolean;
}

/**
 * Supervises the ARI event WebSocket for one PBX connection (Phase 11).
 * Calls that enter the Stasis app emit the SAME normalized call.* vocabulary
 * as the AMI path, so nothing downstream changes; on StasisStart it also runs
 * the CRM-driven IVR routing decision. Exposes its AriClient for supervisor
 * coaching (snoop). One driver='ari' connection is served by exactly one
 * instance, so it is the sole event source for its calls (no AMI double-emit).
 */
export class AriConnection {
  private readonly logger: Logger;
  readonly client: AriClient;
  private readonly calls = new Map<string, AriCall>();
  private reconnectMs = 1_000;
  private stopped = false;
  public connected = false;

  constructor(
    private readonly target: AriConnectionTarget,
    private readonly bus: EventEmitter2,
    private readonly registry: TenantRegistryService,
    private readonly routing: RoutingService,
    private readonly resolveContact: ContactResolver = async () => null,
  ) {
    this.logger = new Logger(`ARI:${target.name}`);
    this.client = new AriClient(target);
    this.client.on('event', (e: AriEvent) => this.onEvent(e));
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.client.destroy();
  }

  status() {
    return { connectionId: this.target.connectionId, name: this.target.name, driver: 'ari', connected: this.connected };
  }

  fingerprint(): string {
    return JSON.stringify([this.target.connectionId, this.target.name, this.target.baseUrl, this.target.app, this.target.username]);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.client.connect();
        this.connected = true;
        this.reconnectMs = 1_000;
        this.logger.log(`ARI connected (${this.target.baseUrl}, app ${this.target.app})`);
        this.bus.emit('pbx.connected', { connectionId: this.target.connectionId });
        await new Promise<void>((resolve) => this.client.once('close', () => resolve()));
        this.connected = false;
        if (!this.stopped) this.logger.warn('ARI event socket closed');
      } catch (err) {
        this.connected = false;
        this.logger.error(`ARI connect failed: ${(err as Error).message}`);
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, this.reconnectMs));
      this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);
    }
  }

  private onEvent(e: AriEvent): void {
    switch (e.type) {
      case 'StasisStart':
        return void this.onStasisStart(e);
      case 'ChannelStateChange':
        if (e.channel?.state === 'Up') this.markAnswered(e.channel.id);
        return;
      case 'StasisEnd':
      case 'ChannelDestroyed':
        return this.finalize(e.channel?.id, e);
      default:
        return;
    }
  }

  private async onStasisStart(e: AriEvent): Promise<void> {
    const ch = e.channel;
    if (!ch?.id) return;
    const remoteNumber = ch.caller?.number || undefined;
    const context = ch.dialplan?.context;
    const tenant = this.registry.resolveTenantForCall(this.target.connectionId, {
      context,
      extensions: [ch.caller?.number, ch.connected?.number].filter(Boolean) as string[],
    });
    const call: AriCall = { channelId: ch.id, startedAt: new Date(), tenant, remoteNumber, ended: false };
    this.calls.set(ch.id, call);

    if (tenant) {
      this.bus.emit(CALL_EVENTS.ringing, {
        callId: ch.id,
        tenantId: tenant.entity.slug,
        direction: 'inbound',
        remoteNumber,
        startedAt: call.startedAt.toISOString(),
      });
    }

    // CRM-driven IVR: look the caller up, decide, apply, hand back to dialplan.
    try {
      const contact = tenant && remoteNumber ? await this.resolveContact(remoteNumber, tenant) : null;
      const decision = this.routing.decide(remoteNumber ?? '', contact);
      for (const [k, v] of Object.entries(decision.variables)) {
        await this.client.setChannelVar(ch.id, k, v).catch(() => undefined);
      }
      if (decision.prompt) await this.client.playback(ch.id, decision.prompt).catch(() => undefined);
      await this.client.continueInDialplan(ch.id).catch(() => undefined);
      this.logger.log(`[${tenant?.entity.slug ?? '?'}] IVR routed ${remoteNumber} -> ${decision.queue} (${decision.priority})`);
    } catch (err) {
      this.logger.warn(`IVR routing failed for ${ch.id}: ${(err as Error).message}`);
    }
  }

  private markAnswered(channelId?: string): void {
    const call = channelId ? this.calls.get(channelId) : undefined;
    if (!call || call.answeredAt) return;
    call.answeredAt = new Date();
    if (!call.tenant) return;
    this.bus.emit(CALL_EVENTS.answered, {
      callId: call.channelId,
      tenantId: call.tenant.entity.slug,
      answeredAt: call.answeredAt.toISOString(),
    });
  }

  private finalize(channelId?: string, _e?: AriEvent): void {
    const call = channelId ? this.calls.get(channelId) : undefined;
    if (!call || call.ended) return;
    call.ended = true;
    this.calls.delete(channelId!);
    if (!call.tenant) return;
    const endedAt = new Date();
    this.bus.emit(CALL_EVENTS.ended, {
      callId: call.channelId,
      tenantId: call.tenant.entity.slug,
      direction: 'inbound',
      remoteNumber: call.remoteNumber,
      disposition: call.answeredAt ? 'ANSWERED' : 'NO ANSWER',
      durationSec: Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000),
      billsecSec: call.answeredAt ? Math.round((endedAt.getTime() - call.answeredAt.getTime()) / 1000) : 0,
      startedAt: call.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
    });
  }
}
