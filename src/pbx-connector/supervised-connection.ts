import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AmiClient, AmiMessage } from './ami-client';

export interface ConnectionTarget {
  connectionId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  secret: string;
}

/**
 * One supervised AMI connection: connect loop with exponential backoff,
 * events re-emitted on the bus as 'ami.event' { connectionId, msg }.
 * Failures are isolated — one tenant's unreachable PBX never affects
 * another connection's loop.
 */
export class SupervisedConnection {
  private readonly logger: Logger;
  private client?: AmiClient;
  private reconnectDelayMs = 1_000;
  private stopped = false;
  public connected = false;

  constructor(
    private readonly target: ConnectionTarget,
    private readonly bus: EventEmitter2,
  ) {
    this.logger = new Logger(`AMI:${target.name}`);
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.client?.destroy();
  }

  async sendAction(action: AmiMessage): Promise<AmiMessage> {
    if (!this.client || !this.connected) {
      throw new Error(`PBX connection '${this.target.name}' is down`);
    }
    return this.client.sendAction(action);
  }

  status() {
    return { connectionId: this.target.connectionId, name: this.target.name, connected: this.connected };
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const client = new AmiClient({
        host: this.target.host,
        port: this.target.port,
        username: this.target.username,
        secret: this.target.secret,
      });
      client.on('event', (msg: AmiMessage) =>
        this.bus.emit('ami.event', { connectionId: this.target.connectionId, msg }),
      );

      try {
        await client.connect();
        this.client = client;
        this.connected = true;
        this.reconnectDelayMs = 1_000;
        this.logger.log(`Connected to ${this.target.host}:${this.target.port}`);
        this.bus.emit('pbx.connected', { connectionId: this.target.connectionId });

        await new Promise<void>((resolve) => client.once('close', () => resolve()));
        this.connected = false;
        if (!this.stopped) this.logger.warn('Connection lost');
      } catch (err) {
        this.connected = false;
        this.logger.error(`Connect failed: ${(err as Error).message}`);
        client.destroy();
      }

      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, this.reconnectDelayMs));
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    }
  }
}
