import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { POD_IDENTITY } from './cluster.types';

export const CLUSTER_CHANNEL = 'cti:bus';

/** Control events that exist only to keep replicas in step. */
export const CLUSTER_EVENTS = {
  registryReload: 'cluster.registry.reload',
  tokenInvalidate: 'cluster.token.invalidate',
} as const;

/**
 * Marks a payload that arrived from another pod, so the receiving pod
 * re-emits it locally without publishing it straight back out. A Symbol is
 * deliberate: it never survives JSON.stringify, so it cannot leak into a
 * webhook body or a CRM write.
 */
const FROM_CLUSTER = Symbol('fromCluster');

/**
 * True when this event reached us over the cluster bus rather than being
 * derived here from the PBX.
 *
 * The rule it enforces: **only the pod that derived an event may enqueue
 * delivery for it.** Every pod re-emits mirrored events locally so agent
 * WebSockets fan out everywhere, but if each pod's dispatcher also enqueued,
 * one call would produce N CRM records — the exact bug single ownership
 * exists to prevent. Ownership alone is not enough, because a replica that
 * owns no connection still receives the event.
 */
export function isFromCluster(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && FROM_CLUSTER in payload;
}

/**
 * Only these prefixes cross the wire. `ami.event` is excluded on purpose —
 * it is a per-connection firehose of raw AMI frames, meaningful only to the
 * pod holding that socket, and mirroring it would put every PBX's full event
 * stream through Redis.
 */
const MIRRORED = ['call.', 'agent.', 'queue.', 'cluster.'];

/**
 * The distributed event bus (ADR-0012).
 *
 * `EventEmitter2` is in-process. Once a PBX connection has a single owner,
 * the pod deriving `call.ringing` is almost never the pod holding the agent's
 * softphone WebSocket — so without this bridge, screen pops silently stop.
 *
 * Every mirrored local emission is published to one Redis channel and
 * re-emitted on every other pod's local emitter, leaving the existing
 * `@OnEvent` consumers untouched. Exactly-once delivery to the CRMs is not
 * this class's job: it falls out of single ownership, because only the owning
 * pod ever emits the event in the first place.
 */
@Injectable()
export class ClusterBusService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ClusterBusService.name);
  private subscriber?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(POD_IDENTITY) private readonly podId: string,
    private readonly bus: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    // A subscribed connection cannot issue ordinary commands, so pub/sub gets
    // its own socket while publishing reuses the shared client.
    this.subscriber = this.redis.duplicate();
    await this.subscriber.subscribe(CLUSTER_CHANNEL);
    this.subscriber.on('message', (_channel, raw) => this.receive(raw));

    this.bus.onAny((event: string | string[], payload: unknown) => {
      const name = Array.isArray(event) ? event.join('.') : event;
      this.publish(name, payload);
    });

    this.logger.log(`Cluster bus attached as ${this.podId}`);
  }

  /** Emit an event on every pod, including this one. */
  broadcast(event: string, payload: unknown = {}): void {
    this.bus.emit(event, payload);
  }

  private publish(event: string, payload: unknown): void {
    if (!MIRRORED.some((p) => event.startsWith(p))) return;
    if (payload && typeof payload === 'object' && FROM_CLUSTER in payload) return;

    void this.redis
      .publish(CLUSTER_CHANNEL, JSON.stringify({ podId: this.podId, event, payload }))
      .catch((err) => this.logger.warn(`Cluster publish failed: ${(err as Error).message}`));
  }

  private receive(raw: string): void {
    let message: { podId: string; event: string; payload: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.podId === this.podId) return; // our own echo

    const payload = (message.payload ?? {}) as Record<PropertyKey, unknown>;
    if (typeof payload === 'object') {
      Object.defineProperty(payload, FROM_CLUSTER, { value: true, enumerable: false });
    }
    this.bus.emit(message.event, payload);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.subscriber) await this.subscriber.quit();
  }
}
