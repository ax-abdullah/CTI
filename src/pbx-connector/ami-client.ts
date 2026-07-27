import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';

export type AmiMessage = Record<string, string>;

export interface AmiClientOptions {
  /** TCP target — used when no pre-established stream is supplied. */
  host?: string;
  port?: number;
  username: string;
  secret: string;
  actionTimeoutMs?: number;
  /**
   * Pre-established transport (e.g. a reverse-connector WebSocket wrapped
   * as a Duplex). When set, host/port are ignored — the protocol is
   * identical, only the pipe differs.
   */
  stream?: Duplex;
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
  private socket?: Duplex;
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
      if (this.opts.stream) {
        this.socket = this.opts.stream;
        resolve();
      } else {
        const socket = connect({ host: this.opts.host!, port: this.opts.port! });
        this.socket = socket;
        socket.setKeepAlive(true, 10_000);
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      }
      this.socket.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
      this.socket.on('close', () => this.teardown(new Error('AMI transport closed')));
      this.socket.on('end', () => this.teardown(new Error('AMI transport ended')));
      this.socket.on('error', () => this.socket?.destroy());
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

  /**
   * Sends an action whose reply is a stream of events (e.g. CoreShowChannels
   * → many CoreShowChannel events, then CoreShowChannelsComplete). Collects
   * every event carrying this action's ActionID until `completeEvent`, and
   * returns them (the terminating event excluded).
   */
  async sendEventAction(action: AmiMessage, completeEvent: string): Promise<AmiMessage[]> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error('AMI not connected');
    const actionId = randomUUID();
    const collected: AmiMessage[] = [];
    const timeoutMs = this.opts.actionTimeoutMs ?? 10_000;

    return new Promise<AmiMessage[]>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(actionId);
        this.off('event', onEvent);
      };
      const fail = (err: Error) => {
        cleanup();
        reject(err);
      };
      const arm = () =>
        setTimeout(() => fail(new Error(`AMI action ${action.Action} timed out`)), timeoutMs);

      const onEvent = (msg: AmiMessage) => {
        if (msg.ActionID !== actionId) return;
        if (msg.Event === completeEvent) {
          cleanup();
          resolve(collected);
        } else {
          collected.push(msg);
        }
      };
      timer = arm();
      this.on('event', onEvent);

      // Asterisk answers the action itself before streaming the event list.
      // `Success` only acks that a list follows; `Error` is terminal — most
      // often a manager user lacking the action's read class (CoreShowChannels
      // needs `reporting`) — so fail with that message instead of waiting out
      // the timeout for a completion event that will never arrive.
      // dispatch() consumes this entry and clears its timer, hence the re-arm.
      this.pending.set(actionId, {
        resolve: (res: AmiMessage) => {
          if (res.Response === 'Success') {
            timer = arm();
            return;
          }
          fail(new Error(`AMI action ${action.Action} failed: ${res.Message ?? res.Response}`));
        },
        reject: fail,
        timer,
      });

      const frame =
        Object.entries({ ...action, ActionID: actionId })
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') + '\r\n\r\n';
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

  private torn = false;

  private teardown(err: Error): void {
    if (this.torn) return;
    this.torn = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    this.emit('close', err);
  }
}
