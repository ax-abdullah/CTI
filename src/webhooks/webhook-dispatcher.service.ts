import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { CALL_EVENTS } from '../call-state/normalized-events';
import { isFromCluster } from '../cluster/cluster-bus.service';
import { WEBHOOK_QUEUE, WebhookEnvelope, WebhookJob } from './webhook.types';

/**
 * Producer side: turns every normalized call event into a durable BullMQ
 * job. Delivery, retries with exponential backoff, and dead-lettering are
 * the processor's job — a slow or down CRM endpoint never blocks the event
 * pipeline, and jobs survive an app restart (Redis-backed).
 */
@Injectable()
export class WebhookDispatcherService {
  constructor(@InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue<WebhookJob>) {}

  @OnEvent(CALL_EVENTS.ringing)
  onRinging(payload: { tenantId: string }): Promise<unknown> {
    return this.enqueue(CALL_EVENTS.ringing, payload);
  }

  @OnEvent(CALL_EVENTS.answered)
  onAnswered(payload: { tenantId: string }): Promise<unknown> {
    return this.enqueue(CALL_EVENTS.answered, payload);
  }

  @OnEvent(CALL_EVENTS.ended)
  onEnded(payload: { tenantId: string }): Promise<unknown> {
    return this.enqueue(CALL_EVENTS.ended, payload);
  }

  private enqueue(type: WebhookEnvelope['type'], payload: { tenantId: string }): Promise<unknown> {
    // Mirrored onto every replica for socket fan-out; only the pod that
    // derived it from the PBX enqueues delivery (ADR-0012).
    if (isFromCluster(payload)) return Promise.resolve(undefined);

    const job: WebhookJob = {
      envelope: {
        id: randomUUID(),
        type,
        tenantId: payload.tenantId,
        occurredAt: new Date().toISOString(),
        data: payload,
      },
    };
    return this.queue.add(type, job, {
      attempts: 4,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: false, // failed jobs are the Phase 2 dead-letter record
    });
  }
}
