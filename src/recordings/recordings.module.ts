import { Module } from '@nestjs/common';
import { RecordingsService } from './recordings.service';
import { RecordingsController } from './recordings.controller';

@Module({
  providers: [RecordingsService],
  controllers: [RecordingsController],
  exports: [RecordingsService],
})
export class RecordingsModule {}
