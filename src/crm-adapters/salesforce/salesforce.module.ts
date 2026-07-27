import { BullModule } from '@nestjs/bullmq';
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { CtiRole } from '../../cluster/cluster.types';
import { TenantsModule } from '../../tenants/tenants.module';
import { SalesforceTokenService } from './salesforce-token.service';
import { SalesforceDispatcher } from './salesforce.dispatcher';
import { SalesforceProcessor } from './salesforce.processor';
import { SALESFORCE_QUEUE } from './salesforce.types';

/**
 * Dispatcher (producer) loads only where call events are derived, so the
 * enqueue happens exactly once; processor (consumer) loads on workers, which
 * scale on queue depth. See ADR-0013.
 *
 * The token service ships with the processor — it is the side that talks to
 * the CRM and invalidates on 401.
 */
@Module({})
export class SalesforceModule {
  static forRole(role: CtiRole): DynamicModule {
    const providers: Provider[] = [];
    if (role === 'all' || role === 'connector') providers.push(SalesforceDispatcher);
    if (role === 'all' || role === 'worker') providers.push(SalesforceTokenService, SalesforceProcessor);
    return {
      module: SalesforceModule,
      imports: [BullModule.registerQueue({ name: SALESFORCE_QUEUE }), TenantsModule],
      providers,
    };
  }
}
