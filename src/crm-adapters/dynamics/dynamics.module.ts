import { BullModule } from '@nestjs/bullmq';
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { CtiRole } from '../../cluster/cluster.types';
import { TenantsModule } from '../../tenants/tenants.module';
import { DynamicsTokenService } from './dynamics-token.service';
import { DynamicsDispatcher } from './dynamics.dispatcher';
import { DynamicsProcessor } from './dynamics.processor';
import { DYNAMICS_QUEUE } from './dynamics.types';

/**
 * Dispatcher (producer) loads only where call events are derived, so the
 * enqueue happens exactly once; processor (consumer) loads on workers, which
 * scale on queue depth. See ADR-0013.
 *
 * The token service ships with the processor — it is the side that talks to
 * the CRM and invalidates on 401.
 */
@Module({})
export class DynamicsModule {
  static forRole(role: CtiRole): DynamicModule {
    const providers: Provider[] = [];
    if (role === 'all' || role === 'connector') providers.push(DynamicsDispatcher);
    if (role === 'all' || role === 'worker') providers.push(DynamicsTokenService, DynamicsProcessor);
    return {
      module: DynamicsModule,
      imports: [BullModule.registerQueue({ name: DYNAMICS_QUEUE }), TenantsModule],
      providers,
    };
  }
}
