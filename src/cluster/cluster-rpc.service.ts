import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT } from '../redis/redis.module';
import { POD_IDENTITY } from './cluster.types';
import { LeaseKind, LeaseService } from './lease.service';

const REQUEST_CHANNEL = 'cti:rpc:req';
const replyChannel = (podId: string) => `cti:rpc:reply:${podId}`;

interface RpcRequest {
  correlationId: string;
  replyTo: string;
  kind: LeaseKind;
  connectionId: string;
  method: string;
  args: unknown[];
}

interface RpcReply {
  correlationId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

type Handler = (connectionId: string, ...args: never[]) => Promise<unknown>;

/**
 * Cross-pod command channel (ADR-0012).
 *
 * A PBX socket lives on exactly one pod, but the request to use it arrives
 * wherever the load balancer put it — and for a reverse connection the socket
 * is pinned to the pod the customer's connector agent dialled into. Without
 * this, click-to-call, coaching and recording downloads fail on every replica
 * that does not happen to hold the tunnel.
 *
 * Request/reply over Redis pub/sub: every connector pod sees the request,
 * only the current lease holder answers, and the reply goes to a channel
 * private to the calling pod.
 */
@Injectable()
export class ClusterRpcService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ClusterRpcService.name);
  private readonly handlers = new Map<string, Handler>();
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private requests?: Redis;
  private replies?: Redis;

  /** Longer than the 10s AMI action timeout, so the PBX's own error wins. */
  private readonly timeoutMs: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(POD_IDENTITY) private readonly podId: string,
    private readonly leases: LeaseService,
    config: ConfigService,
  ) {
    this.timeoutMs = Number(config.get('CLUSTER_RPC_TIMEOUT_MS', '15000'));
  }

  async onModuleInit(): Promise<void> {
    this.replies = this.redis.duplicate();
    await this.replies.subscribe(replyChannel(this.podId));
    this.replies.on('message', (_c, raw) => this.onReply(raw));

    this.requests = this.redis.duplicate();
    await this.requests.subscribe(REQUEST_CHANNEL);
    this.requests.on('message', (_c, raw) => void this.onRequest(raw));
  }

  /** Connector-side: expose a command the owning pod can execute. */
  register(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  /**
   * Caller-side: run `method` on whichever pod holds the lease. Resolves with
   * that pod's return value, or rejects with its error message — including
   * the PBX's own text, which is what makes a refused AMI action legible.
   */
  call<T>(kind: LeaseKind, connectionId: string, method: string, ...args: unknown[]): Promise<T> {
    const correlationId = randomUUID();
    const request: RpcRequest = {
      correlationId,
      replyTo: replyChannel(this.podId),
      kind,
      connectionId,
      method,
      args,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(
          new Error(
            `No pod answered ${method} for connection ${connectionId} — it may have no owner right now`,
          ),
        );
      }, this.timeoutMs);

      this.pending.set(correlationId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      void this.redis.publish(REQUEST_CHANNEL, JSON.stringify(request));
    });
  }

  private async onRequest(raw: string): Promise<void> {
    let request: RpcRequest;
    try {
      request = JSON.parse(raw);
    } catch {
      return;
    }
    // Every connector pod sees every request; only the owner may act. This is
    // the same guard that stops two pods driving one PBX.
    if (!this.leases.holds(request.kind, request.connectionId)) return;

    const handler = this.handlers.get(request.method);
    const reply: RpcReply = { correlationId: request.correlationId, ok: true };
    if (!handler) {
      reply.ok = false;
      reply.error = `Unknown cluster method '${request.method}'`;
    } else {
      try {
        reply.result = await handler(request.connectionId, ...(request.args as never[]));
      } catch (err) {
        reply.ok = false;
        reply.error = (err as Error).message;
      }
    }
    await this.redis.publish(request.replyTo, JSON.stringify(reply));
  }

  private onReply(raw: string): void {
    let reply: RpcReply;
    try {
      reply = JSON.parse(raw);
    } catch {
      return;
    }
    const waiter = this.pending.get(reply.correlationId);
    if (!waiter) return; // already timed out
    this.pending.delete(reply.correlationId);
    clearTimeout(waiter.timer);
    if (reply.ok) waiter.resolve(reply.result);
    else waiter.reject(new Error(reply.error ?? 'Remote command failed'));
  }

  async onApplicationShutdown(): Promise<void> {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('Shutting down'));
    }
    this.pending.clear();
    if (this.requests) await this.requests.quit();
    if (this.replies) await this.replies.quit();
  }
}
