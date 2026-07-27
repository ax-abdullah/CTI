import { BullModule } from '@nestjs/bullmq';
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { CtiRole } from '../../cluster/cluster.types';
import { TenantsModule } from '../../tenants/tenants.module';
import { HubSpotTokenService } from './hubspot-token.service';
import { HubSpotDispatcher } from './hubspot.dispatcher';
import { HubSpotProcessor } from './hubspot.processor';
import { HUBSPOT_QUEUE } from './hubspot.types';

/**
 * Dispatcher (producer) loads only where call events are derived, so the
 * enqueue happens exactly once; processor (consumer) loads on workers, which
 * scale on queue depth. See ADR-0013.
 *
 * The token service ships with the processor — it is the side that talks to
 * the CRM and invalidates on 401.
 */
@Module({})
export class HubSpotModule {
  static forRole(role: CtiRole): DynamicModule {
    const providers: Provider[] = [];
    if (role === 'all' || role === 'connector') providers.push(HubSpotDispatcher);
    if (role === 'all' || role === 'worker') providers.push(HubSpotTokenService, HubSpotProcessor);
    return {
      module: HubSpotModule,
      imports: [BullModule.registerQueue({ name: HUBSPOT_QUEUE }), TenantsModule],
      providers,
    };
  }
}
