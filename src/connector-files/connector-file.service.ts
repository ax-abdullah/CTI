import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

interface Pending {
  chunks: Buffer[];
  resolve: (buf: Buffer | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * Fetches recording files from reverse-mode on-prem connector agents over
 * their file channel (/connector-files), so a NAT'd customer needs no shared
 * recordings mount — the ADR-0007/0008 extension. Protocol (JSON over WS):
 *   cloud → agent : { t:'fetch', id, file }
 *   agent → cloud : { t:'chunk', id, data(base64) } * , then { t:'eof', id }
 *                   or { t:'error', id, message }
 */
@Injectable()
export class ConnectorFileService {
  private readonly agents = new Map<string, WebSocket>();
  private readonly pending = new Map<string, Pending>();

  register(connectionId: string, socket: WebSocket): void {
    this.agents.set(connectionId, socket);
    socket.on('message', (data: Buffer) => this.onMessage(data.toString('utf8')));
  }

  unregister(connectionId: string): void {
    this.agents.delete(connectionId);
  }

  isConnected(connectionId: string): boolean {
    return this.agents.has(connectionId);
  }

  /** Requests a file from the agent; resolves null on timeout / miss / error. */
  fetch(connectionId: string, file: string, timeoutMs = 10_000): Promise<Buffer | null> {
    const socket = this.agents.get(connectionId);
    if (!socket) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise<Buffer | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, { chunks: [], resolve, timer });
      socket.send(JSON.stringify({ t: 'fetch', id, file }));
    });
  }

  private onMessage(raw: string): void {
    let msg: { t: string; id: string; data?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.t === 'chunk' && msg.data) {
      p.chunks.push(Buffer.from(msg.data, 'base64'));
    } else if (msg.t === 'eof') {
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(Buffer.concat(p.chunks));
    } else if (msg.t === 'error') {
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(null);
    }
  }
}
