import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { PbxConnectorModule } from '../pbx-connector/pbx-connector.module';
import { SoftphoneGateway } from './softphone.gateway';
import { SoftphoneController } from './softphone.controller';

@Module({
  imports: [TenantsModule, PbxConnectorModule],
  providers: [SoftphoneGateway],
  controllers: [SoftphoneController],
})
export class SoftphoneModule {}
