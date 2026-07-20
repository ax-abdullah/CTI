import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { AmiClient, AmiMessage } from './ami-client';

export interface OriginateRequest {
  agentExt: string;
  number: string;
  callRef?: string;
}

/**
 * Owns the AMI connection for the tenant's PBX (Phase 1: single tenant).
 * Re-emits every AMI event on the internal bus as 'ami.event' with the
 * tenantId attached, and executes Originate actions for click-to-call.
 * In Phase 2 this becomes one supervised instance per tenant PBX.
 */
@Injectable()
export class AmiConnectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AmiConnectionService.name);
  private client?: AmiClient;
  private reconnectDelayMs = 1_000;
  private shuttingDown = false;
  public connected = false;

  constructor(
    private readonly config: ConfigService,
    private readonly bus: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    void this.connectLoop();
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    this.client?.destroy();
  }

  /** Click-to-call: agent-leg-first originate. */
  async originate(req: OriginateRequest): Promise<{ callRef: string }> {
    if (!this.client || !this.connected) throw new Error('PBX connection is down');

    const callRef = req.callRef ?? randomUUID();
    const template = this.config.getOrThrow<string>('ORIGINATE_CHANNEL_TEMPLATE');
    const channel = template.replaceAll('{ext}', req.agentExt);

    const res = await this.client.sendAction({
      Action: 'Originate',
      Channel: channel,
      Context: this.config.getOrThrow<string>('ORIGINATE_CONTEXT'),
      Exten: req.number,
      Priority: '1',
      // Present the destination number to the agent's phone while it rings.
      CallerID: `${req.number} <${req.number}>`,
      Timeout: '30000',
      Async: 'true',
      Variable: `CTI_CALL_REF=${callRef}`,
    });
    if (res.Response !== 'Success') {
      throw new Error(`Originate rejected: ${res.Message ?? 'unknown'}`);
    }
    this.logger.log(`Originated ${channel} -> ${req.number} (ref ${callRef})`);
    return { callRef };
  }

  private async connectLoop(): Promise<void> {
    while (!this.shuttingDown) {
      const client = new AmiClient({
        host: this.config.getOrThrow('AMI_HOST'),
        port: Number(this.config.getOrThrow('AMI_PORT')),
        username: this.config.getOrThrow('AMI_USERNAME'),
        secret: this.config.getOrThrow('AMI_SECRET'),
      });
      client.on('event', (msg: AmiMessage) =>
        this.bus.emit('ami.event', { tenantId: this.config.get('TENANT_ID'), msg }),
      );

      try {
        await client.connect();
        this.client = client;
        this.connected = true;
        this.reconnectDelayMs = 1_000;
        this.logger.log(`AMI connected to ${this.config.get('AMI_HOST')}:${this.config.get('AMI_PORT')}`);
        this.bus.emit('pbx.connected', { tenantId: this.config.get('TENANT_ID') });

        await new Promise<void>((resolve) => client.once('close', () => resolve()));
        this.connected = false;
        if (!this.shuttingDown) this.logger.warn('AMI connection lost');
      } catch (err) {
        this.connected = false;
        this.logger.error(`AMI connect failed: ${(err as Error).message}`);
        client.destroy();
      }

      if (this.shuttingDown) return;
      await new Promise((r) => setTimeout(r, this.reconnectDelayMs));
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    }
  }
}
