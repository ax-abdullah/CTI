import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { PbxConnectorModule } from '../pbx-connector/pbx-connector.module';
import { SupervisorService } from './supervisor.service';
import { QueueStatsService } from './queue-stats.service';
import { TelephonyController } from './telephony.controller';

/** Phase 11 advanced telephony: supervisor coaching + queue/ACD wallboard. */
@Module({
  imports: [TenantsModule, PbxConnectorModule],
  providers: [SupervisorService, QueueStatsService],
  controllers: [TelephonyController],
  exports: [QueueStatsService],
})
export class TelephonyModule {}
