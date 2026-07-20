import { Module } from '@nestjs/common';
import { PbxConnectorModule } from '../pbx-connector/pbx-connector.module';
import { CallStateModule } from '../call-state/call-state.module';
import { CallsController } from './calls.controller';

@Module({
  imports: [PbxConnectorModule, CallStateModule],
  controllers: [CallsController],
})
export class ApiModule {}
