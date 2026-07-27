import { BullModule } from '@nestjs/bullmq';
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { CtiRole } from '../cluster/cluster.types';
import { TenantsModule } from '../tenants/tenants.module';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookProcessor } from './webhook.processor';
import { WEBHOOK_QUEUE } from './webhook.types';

/**
 * Producer and consumer are wired independently by role (ADR-0012/0013):
 *
 * - the **dispatcher** loads only where events are derived — alongside the PBX
 *   connections — so the enqueue happens exactly once per call;
 * - the **processor** loads on workers, which scale on queue depth.
 *
 * The queue itself is registered for every role, because `api` replicas read
 * job counts from it for the admin console and dead-letter views.
 */
@Module({})
export class WebhooksModule {
  static forRole(role: CtiRole): DynamicModule {
    const providers: Provider[] = [];
    if (role === 'all' || role === 'connector') providers.push(WebhookDispatcherService);
    if (role === 'all' || role === 'worker') providers.push(WebhookProcessor);
    return {
      module: WebhooksModule,
      imports: [BullModule.registerQueue({ name: WEBHOOK_QUEUE }), TenantsModule],
      providers,
    };
  }
}
