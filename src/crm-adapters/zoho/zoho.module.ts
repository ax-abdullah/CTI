import { BullModule } from '@nestjs/bullmq';
import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { CtiRole } from '../../cluster/cluster.types';
import { TenantsModule } from '../../tenants/tenants.module';
import { PbxConnectorModule } from '../../pbx-connector/pbx-connector.module';
import { ZohoTokenService } from './zoho-token.service';
import { ZohoDispatcher } from './zoho.dispatcher';
import { ZohoProcessor } from './zoho.processor';
import { ZohoCallbackController } from './zoho-callback.controller';
import { ZOHO_QUEUE } from './zoho.types';

/**
 * Zoho is the one adapter that spans all three roles, because click-to-call
 * comes back *in* from the CRM:
 *
 * - `connector` — the dispatcher, so the enqueue happens exactly once;
 * - `worker` — the processor and its OAuth token cache;
 * - `api` — the click-to-call callback controller, which resolves the Zoho
 *   user to an extension and originates. On a replica that does not own that
 *   PBX the originate is routed to the one that does (ADR-0012).
 */
@Module({})
export class ZohoModule {
  static forRole(role: CtiRole): DynamicModule {
    const providers: Provider[] = [];
    const controllers: Type<unknown>[] = [];
    if (role === 'all' || role === 'connector') providers.push(ZohoDispatcher);
    if (role === 'all' || role === 'worker') providers.push(ZohoTokenService, ZohoProcessor);
    if (role === 'all' || role === 'api') controllers.push(ZohoCallbackController);
    return {
      module: ZohoModule,
      imports: [BullModule.registerQueue({ name: ZOHO_QUEUE }), TenantsModule, PbxConnectorModule],
      providers,
      controllers,
    };
  }
}
