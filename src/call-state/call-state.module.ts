import { Module } from '@nestjs/common';
import { CallStateService } from './call-state.service';

@Module({
  providers: [CallStateService],
  exports: [CallStateService],
})
export class CallStateModule {}
