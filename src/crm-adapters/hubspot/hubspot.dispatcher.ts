import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { CALL_EVENTS, CallEndedEvent } from '../../call-state/normalized-events';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';
import { HUBSPOT_QUEUE, HubSpotJob } from './hubspot.types';

@Injectable()
export class HubSpotDispatcher {
  constructor(
    @InjectQueue(HUBSPOT_QUEUE) private readonly queue: Queue<HubSpotJob>,
    private readonly registry: TenantRegistryService,
  ) {}

  @OnEvent(CALL_EVENTS.ended)
  onEnded(event: CallEndedEvent): Promise<unknown> | void {
    if (!this.registry.integrationFor(event.tenantId, 'hubspot')) return;
    return this.queue.add('log-call', { tenantSlug: event.tenantId, event }, {
      attempts: 4,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: false,
    });
  }
}
