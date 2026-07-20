import { Module } from '@nestjs/common';
import { PbxConnectorModule } from '../pbx-connector/pbx-connector.module';
import { CallStateModule } from '../call-state/call-state.module';
import { PresenceModule } from '../presence/presence.module';
import { TenantsModule } from '../tenants/tenants.module';
import { CallsController } from './calls.controller';

@Module({
  imports: [PbxConnectorModule, CallStateModule, PresenceModule, TenantsModule],
  controllers: [CallsController],
})
export class ApiModule {}
