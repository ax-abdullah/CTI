import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { CallStateModule } from '../call-state/call-state.module';
import { PbxSupervisorService } from './pbx-supervisor.service';
import { ReverseConnectorGateway } from './reverse-connector.gateway';
import { ResyncService } from './resync.service';
import { RoutingService } from './ari/routing.service';
import { AriSupervisorService } from './ari/ari-supervisor.service';

@Module({
  imports: [TenantsModule, CallStateModule],
  providers: [PbxSupervisorService, ReverseConnectorGateway, ResyncService, RoutingService, AriSupervisorService],
  exports: [PbxSupervisorService, AriSupervisorService, RoutingService],
})
export class PbxConnectorModule {}
