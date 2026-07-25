import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CallStateModule } from '../call-state/call-state.module';
import { PbxConnectorModule } from '../pbx-connector/pbx-connector.module';
import { TenantsModule } from '../tenants/tenants.module';
import { Agent } from '../tenants/entities/agent.entity';
import { CrmIntegration } from '../tenants/entities/crm-integration.entity';
import { PbxConnection } from '../tenants/entities/pbx-connection.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { WEBHOOK_QUEUE } from '../webhooks/webhook.types';
import { ZOHO_QUEUE } from '../crm-adapters/zoho/zoho.types';
import { SALESFORCE_QUEUE } from '../crm-adapters/salesforce/salesforce.types';
import { HUBSPOT_QUEUE } from '../crm-adapters/hubspot/hubspot.types';
import { DYNAMICS_QUEUE } from '../crm-adapters/dynamics/dynamics.types';
import { AdminController } from './admin.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([PbxConnection, Tenant, Agent, CrmIntegration]),
    BullModule.registerQueue(
      { name: WEBHOOK_QUEUE },
      { name: ZOHO_QUEUE },
      { name: SALESFORCE_QUEUE },
      { name: HUBSPOT_QUEUE },
      { name: DYNAMICS_QUEUE },
    ),
    TenantsModule,
    PbxConnectorModule,
    CallStateModule,
  ],
  controllers: [AdminController],
})
export class AdminModule {}
