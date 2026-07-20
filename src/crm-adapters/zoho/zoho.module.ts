import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TenantsModule } from '../../tenants/tenants.module';
import { PbxConnectorModule } from '../../pbx-connector/pbx-connector.module';
import { ZohoTokenService } from './zoho-token.service';
import { ZohoDispatcher } from './zoho.dispatcher';
import { ZohoProcessor } from './zoho.processor';
import { ZohoCallbackController } from './zoho-callback.controller';
import { ZOHO_QUEUE } from './zoho.types';

@Module({
  imports: [BullModule.registerQueue({ name: ZOHO_QUEUE }), TenantsModule, PbxConnectorModule],
  providers: [ZohoTokenService, ZohoDispatcher, ZohoProcessor],
  controllers: [ZohoCallbackController],
})
export class ZohoModule {}
