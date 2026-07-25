import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { ConnectorFilesModule } from '../connector-files/connector-files.module';
import { RecordingsService } from './recordings.service';
import { RecordingsController } from './recordings.controller';

@Module({
  imports: [TenantsModule, ConnectorFilesModule],
  providers: [RecordingsService],
  controllers: [RecordingsController],
  exports: [RecordingsService],
})
export class RecordingsModule {}
