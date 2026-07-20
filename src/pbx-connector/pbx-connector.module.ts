import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { PbxSupervisorService } from './pbx-supervisor.service';
import { ReverseConnectorGateway } from './reverse-connector.gateway';

@Module({
  imports: [TenantsModule],
  providers: [PbxSupervisorService, ReverseConnectorGateway],
  exports: [PbxSupervisorService],
})
export class PbxConnectorModule {}
