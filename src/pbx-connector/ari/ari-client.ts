import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

export interface AriClientOptions {
  /** ARI HTTP base, e.g. http://pbx:8088 (no trailing slash). */
  baseUrl: string;
  username: string;
  password: string;
  /** Stasis application name the dialplan hands calls to (Stasis(app)). */
  app: string;
}

export type AriEvent = Record<string, any> & { type: string };

/**
 * Minimal Asterisk REST Interface (ARI) client: a WebSocket for Stasis
 * events + REST for call control (answer, playback, snoop for coaching,
 * continue-in-dialplan for IVR routing). Basic-auth on every REST call;
 * the event socket carries `api_key=user:pass`.
 *
 * Emits: 'event' (AriEvent), 'close' (Error | undefined). Reconnection is
 * the owner's responsibility (see AriConnection), same as AmiClient.
 */
export class AriClient extends EventEmitter {
  private ws?: WebSocket;

  constructor(private readonly opts: AriClientOptions) {
    super();
  }

  /** Opens the event WebSocket for this app; resolves once connected. */
  async connect(): Promise<void> {
    const wsBase = this.opts.baseUrl.replace(/^http/, 'ws');
    const url =
      `${wsBase}/ari/events?app=${encodeURIComponent(this.opts.app)}` +
      `&api_key=${encodeURIComponent(`${this.opts.username}:${this.opts.password}`)}`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.on('message', (data: Buffer) => this.onMessage(data.toString('utf8')));
      ws.on('close', () => this.emit('close'));
    });
  }

  destroy(): void {
    this.ws?.close();
  }

  private onMessage(raw: string): void {
    let msg: AriEvent;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type) this.emit('event', msg);
  }

  // ---------------------------------------------------------------- REST

  /** Authenticated ARI REST call; returns parsed JSON (or undefined on 204). */
  async request<T = unknown>(method: string, path: string, query?: Record<string, string>): Promise<T | undefined> {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const auth = Buffer.from(`${this.opts.username}:${this.opts.password}`).toString('base64');
    const res = await fetch(`${this.opts.baseUrl}/ari${path}${qs}`, {
      method,
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`ARI ${method} ${path}: HTTP ${res.status}`);
    if (res.status === 204) return undefined;
    return (await res.json().catch(() => undefined)) as T;
  }

  answer(channelId: string) {
    return this.request('POST', `/channels/${channelId}/answer`);
  }

  hangup(channelId: string) {
    return this.request('DELETE', `/channels/${channelId}`);
  }

  playback(channelId: string, media: string) {
    return this.request('POST', `/channels/${channelId}/play`, { media });
  }

  /** Hand the channel back to the dialplan (routing decision applied). */
  continueInDialplan(channelId: string, target?: { context?: string; extension?: string; priority?: string }) {
    return this.request('POST', `/channels/${channelId}/continue`, { ...target });
  }

  getChannelVar(channelId: string, variable: string) {
    return this.request<{ value: string }>('GET', `/channels/${channelId}/variable`, { variable });
  }

  setChannelVar(channelId: string, variable: string, value: string) {
    return this.request('POST', `/channels/${channelId}/variable`, { variable, value });
  }

  /**
   * Snoop channel for supervisor coaching:
   *   spy    = 'in'  (listen only), whisper = 'out' (talk to the agent),
   *   barge  = both. The snoop channel enters `app` so the supervisor's
   *   audio can be bridged to it.
   */
  snoop(channelId: string, opts: { spy?: 'none' | 'in' | 'both'; whisper?: 'none' | 'out' | 'both'; app: string }) {
    return this.request('POST', `/channels/${channelId}/snoop`, {
      spy: opts.spy ?? 'none',
      whisper: opts.whisper ?? 'none',
      app: opts.app,
    });
  }
}
