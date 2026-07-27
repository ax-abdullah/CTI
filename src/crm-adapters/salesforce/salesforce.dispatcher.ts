import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { CALL_EVENTS, CallEndedEvent } from '../../call-state/normalized-events';
import { isFromCluster } from '../../cluster/cluster-bus.service';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';
import { SALESFORCE_QUEUE, SalesforceJob } from './salesforce.types';

@Injectable()
export class SalesforceDispatcher {
  constructor(
    @InjectQueue(SALESFORCE_QUEUE) private readonly queue: Queue<SalesforceJob>,
    private readonly registry: TenantRegistryService,
  ) {}

  @OnEvent(CALL_EVENTS.ended)
  onEnded(event: CallEndedEvent): Promise<unknown> | void {
    // Fan-out copy from another pod: that pod already enqueued it (ADR-0012).
    if (isFromCluster(event)) return;
    if (!this.registry.integrationFor(event.tenantId, 'salesforce')) return;
    return this.queue.add('log-call', { tenantSlug: event.tenantId, event }, {
      attempts: 4,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: false,
    });
  }
}
