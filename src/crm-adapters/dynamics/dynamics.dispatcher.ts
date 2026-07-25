import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { CALL_EVENTS, CallEndedEvent } from '../../call-state/normalized-events';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';
import { DYNAMICS_QUEUE, DynamicsJob } from './dynamics.types';

@Injectable()
export class DynamicsDispatcher {
  constructor(
    @InjectQueue(DYNAMICS_QUEUE) private readonly queue: Queue<DynamicsJob>,
    private readonly registry: TenantRegistryService,
  ) {}

  @OnEvent(CALL_EVENTS.ended)
  onEnded(event: CallEndedEvent): Promise<unknown> | void {
    if (!this.registry.integrationFor(event.tenantId, 'dynamics')) return;
    return this.queue.add('log-call', { tenantSlug: event.tenantId, event }, {
      attempts: 4,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: false,
    });
  }
}
