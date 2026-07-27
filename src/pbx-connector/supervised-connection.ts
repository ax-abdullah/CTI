import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Duplex } from 'node:stream';
import { AmiClient, AmiMessage } from './ami-client';

export interface ConnectionTarget {
  connectionId: string;
  name: string;
  mode: 'direct' | 'reverse';
  host: string;
  port: number;
  username: string;
  secret: string;
}

/**
 * One supervised AMI connection, isolated from its siblings.
 *
 * direct:  own connect loop with exponential backoff (cloud dials out).
 * reverse: passive — waits for the customer's on-prem connector agent to
 *          attach a tunneled stream (via /connector-ws); login and protocol
 *          are identical from there. When the tunnel drops we simply wait
 *          for the agent to reconnect (the agent owns the retry loop).
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
    if (this.target.mode === 'direct') void this.directLoop();
    else this.logger.log('Reverse mode: waiting for on-prem connector');
  }

  stop(): void {
    this.stopped = true;
    this.client?.destroy();
  }

  /** Reverse mode: run an AMI session over a tunnel the agent brought up. */
  async attachStream(stream: Duplex): Promise<void> {
    if (this.stopped) {
      stream.destroy();
      return;
    }
    if (this.connected) {
      // One tunnel at a time; a second agent (or a zombie) is refused.
      this.logger.warn('Refusing second reverse tunnel while one is active');
      stream.destroy();
      return;
    }
    const client = this.buildClient({ stream });
    try {
      await client.connect();
      this.client = client;
      this.connected = true;
      this.logger.log('Reverse tunnel up, AMI authenticated');
      this.bus.emit('pbx.connected', { connectionId: this.target.connectionId });
      await new Promise<void>((resolve) => client.once('close', () => resolve()));
    } catch (err) {
      this.logger.error(`Reverse session failed: ${(err as Error).message}`);
      client.destroy();
    } finally {
      this.connected = false;
      if (!this.stopped) this.logger.warn('Reverse tunnel closed; waiting for reconnect');
    }
  }

  async sendAction(action: AmiMessage): Promise<AmiMessage> {
    if (!this.client || !this.connected) {
      throw new Error(`PBX connection '${this.target.name}' is down`);
    }
    return this.client.sendAction(action);
  }

  async sendEventAction(action: AmiMessage, completeEvent: string): Promise<AmiMessage[]> {
    if (!this.client || !this.connected) {
      throw new Error(`PBX connection '${this.target.name}' is down`);
    }
    return this.client.sendEventAction(action, completeEvent);
  }

  status() {
    return {
      connectionId: this.target.connectionId,
      name: this.target.name,
      mode: this.target.mode,
      connected: this.connected,
    };
  }

  /** Used by the supervisor's hot-reload diff. */
  /**
   * Config identity, so a reload can tell "same connection, still running"
   * from "changed, needs restarting". Static too, because the supervisor
   * compares a desired target against a live connection before deciding
   * whether to build one.
   */
  static fingerprintOf(target: ConnectionTarget): string {
    const { connectionId, name, mode, host, port, username, secret } = target;
    return JSON.stringify([connectionId, name, mode, host, port, username, secret]);
  }

  fingerprint(): string {
    return SupervisedConnection.fingerprintOf(this.target);
  }

  private buildClient(extra: { stream?: Duplex } = {}): AmiClient {
    const client = new AmiClient({
      host: this.target.host,
      port: this.target.port,
      username: this.target.username,
      secret: this.target.secret,
      ...extra,
    });
    client.on('event', (msg: AmiMessage) =>
      this.bus.emit('ami.event', { connectionId: this.target.connectionId, msg }),
    );
    return client;
  }

  private async directLoop(): Promise<void> {
    while (!this.stopped) {
      const client = this.buildClient();
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
