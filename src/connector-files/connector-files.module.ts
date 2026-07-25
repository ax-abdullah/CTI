import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { ConnectorFileService } from './connector-file.service';
import { ConnectorFileGateway } from './connector-file.gateway';

@Module({
  imports: [TenantsModule],
  providers: [ConnectorFileService, ConnectorFileGateway],
  exports: [ConnectorFileService],
})
export class ConnectorFilesModule {}
