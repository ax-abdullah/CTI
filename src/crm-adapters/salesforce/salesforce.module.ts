import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TenantsModule } from '../../tenants/tenants.module';
import { SalesforceTokenService } from './salesforce-token.service';
import { SalesforceDispatcher } from './salesforce.dispatcher';
import { SalesforceProcessor } from './salesforce.processor';
import { SALESFORCE_QUEUE } from './salesforce.types';

@Module({
  imports: [BullModule.registerQueue({ name: SALESFORCE_QUEUE }), TenantsModule],
  providers: [SalesforceTokenService, SalesforceDispatcher, SalesforceProcessor],
})
export class SalesforceModule {}
