import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { CallStateService } from './call-state.service';

@Module({
  imports: [TenantsModule],
  providers: [CallStateService],
  exports: [CallStateService],
})
export class CallStateModule {}
