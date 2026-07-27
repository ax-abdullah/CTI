import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import {
  CALL_EVENTS,
  CallAnsweredEvent,
  CallEndedEvent,
  CallRingingEvent,
} from '../../call-state/normalized-events';
import { isFromCluster } from '../../cluster/cluster-bus.service';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';
import { ZOHO_QUEUE, ZohoJob } from './zoho.types';

/**
 * Producer: mirrors normalized call events into the durable Zoho queue —
 * but only for tenants that actually have an enabled Zoho integration.
 * Delivery order per call is preserved by BullMQ's per-job backoff being
 * irrelevant here: ringing/answered/ended are independent notifications
 * keyed by our callId on the Zoho side.
 */
@Injectable()
export class ZohoDispatcher {
  constructor(
    @InjectQueue(ZOHO_QUEUE) private readonly queue: Queue<ZohoJob>,
    private readonly registry: TenantRegistryService,
  ) {}

  @OnEvent(CALL_EVENTS.ringing)
  onRinging(event: CallRingingEvent): Promise<unknown> | void {
    return this.enqueue({ kind: 'ringing', tenantSlug: event.tenantId, event });
  }

  @OnEvent(CALL_EVENTS.answered)
  onAnswered(event: CallAnsweredEvent): Promise<unknown> | void {
    return this.enqueue({ kind: 'answered', tenantSlug: event.tenantId, event });
  }

  @OnEvent(CALL_EVENTS.ended)
  onEnded(event: CallEndedEvent): Promise<unknown> | void {
    return this.enqueue({ kind: 'ended', tenantSlug: event.tenantId, event });
  }

  private enqueue(job: ZohoJob): Promise<unknown> | void {
    // Fan-out copy from another pod: that pod already enqueued it (ADR-0012).
    if (isFromCluster(job.event)) return;
    if (!this.registry.integrationFor(job.tenantSlug, 'zoho')) return;
    return this.queue.add(job.kind, job, {
      attempts: 4,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: false,
    });
  }
}
