import { EventEmitter } from 'node:events';
import { Socket, connect } from 'node:net';
import { randomUUID } from 'node:crypto';

export type AmiMessage = Record<string, string>;

export interface AmiClientOptions {
  host: string;
  port: number;
  username: string;
  secret: string;
  actionTimeoutMs?: number;
}

/**
 * Minimal AMI (Asterisk Manager Interface) client.
 *
 * The wire protocol is CRLF-delimited "Key: Value" frames separated by a
 * blank line. Frames starting with "Event:" are unsolicited events; frames
 * starting with "Response:" answer actions and are matched by ActionID.
 *
 * Emits: 'event' (AmiMessage), 'close' (Error | undefined).
 * Reconnection is the owner's responsibility (see AmiConnectionService).
 */
export class AmiClient extends EventEmitter {
  private socket?: Socket;
  private buffer = '';
  private greeted = false;
  private readonly pending = new Map<
    string,
    { resolve: (m: AmiMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly opts: AmiClientOptions) {
    super();
  }

  /** Connects and logs in. Resolves once authentication is accepted. */
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: this.opts.host, port: this.opts.port });
      this.socket = socket;
      socket.setKeepAlive(true, 10_000);
      socket.once('connect', () => resolve());
      socket.once('error', reject);
      socket.on('data', (chunk) => this.onData(chunk.toString('utf8')));
      socket.on('close', () => this.teardown(new Error('AMI socket closed')));
    });

    const res = await this.sendAction({
      Action: 'Login',
      Username: this.opts.username,
      Secret: this.opts.secret,
    });
    if (res.Response !== 'Success') {
      this.destroy();
      throw new Error(`AMI authentication failed: ${res.Message ?? 'unknown'}`);
    }
  }

  /** Sends an action and resolves with its Response frame. */
  sendAction(action: AmiMessage): Promise<AmiMessage> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('AMI not connected'));
    }
    const actionId = randomUUID();
    const frame =
      Object.entries({ ...action, ActionID: actionId })
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') + '\r\n\r\n';

    return new Promise<AmiMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject(new Error(`AMI action ${action.Action} timed out`));
      }, this.opts.actionTimeoutMs ?? 10_000);
      this.pending.set(actionId, { resolve, reject, timer });
      socket.write(frame);
    });
  }

  destroy(): void {
    this.socket?.destroy();
  }

  private onData(text: string): void {
    this.buffer += text;

    // The banner line ("Asterisk Call Manager/x.y") is not a frame.
    if (!this.greeted) {
      const nl = this.buffer.indexOf('\r\n');
      if (nl === -1) return;
      this.greeted = true;
      this.buffer = this.buffer.slice(nl + 2);
    }

    let sep: number;
    while ((sep = this.buffer.indexOf('\r\n\r\n')) !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 4);
      const msg: AmiMessage = {};
      for (const line of raw.split('\r\n')) {
        const colon = line.indexOf(': ');
        if (colon !== -1) msg[line.slice(0, colon)] = line.slice(colon + 2);
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: AmiMessage): void {
    const actionId = msg.ActionID;
    if (msg.Response && actionId && this.pending.has(actionId)) {
      const entry = this.pending.get(actionId)!;
      this.pending.delete(actionId);
      clearTimeout(entry.timer);
      entry.resolve(msg);
      return;
    }
    if (msg.Event) this.emit('event', msg);
  }

  private teardown(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    this.emit('close', err);
  }
}
