import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { PbxSupervisorService } from './pbx-supervisor.service';

@Module({
  imports: [TenantsModule],
  providers: [PbxSupervisorService],
  exports: [PbxSupervisorService],
})
export class PbxConnectorModule {}
