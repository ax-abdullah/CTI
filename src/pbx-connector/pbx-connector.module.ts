import { Module } from '@nestjs/common';
import { AmiConnectionService } from './ami-connection.service';

@Module({
  providers: [AmiConnectionService],
  exports: [AmiConnectionService],
})
export class PbxConnectorModule {}
