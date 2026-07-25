import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TenantsModule } from '../../tenants/tenants.module';
import { HubSpotTokenService } from './hubspot-token.service';
import { HubSpotDispatcher } from './hubspot.dispatcher';
import { HubSpotProcessor } from './hubspot.processor';
import { HUBSPOT_QUEUE } from './hubspot.types';

@Module({
  imports: [BullModule.registerQueue({ name: HUBSPOT_QUEUE }), TenantsModule],
  providers: [HubSpotTokenService, HubSpotDispatcher, HubSpotProcessor],
})
export class HubSpotModule {}
