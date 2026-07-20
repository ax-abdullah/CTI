import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { RecordingsModule } from '../recordings/recordings.module';
import { CallStateService } from './call-state.service';

@Module({
  imports: [TenantsModule, RecordingsModule],
  providers: [CallStateService],
  exports: [CallStateService],
})
export class CallStateModule {}
