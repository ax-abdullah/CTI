import { Module } from '@nestjs/common';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

@Module({
  providers: [WebhookDispatcherService],
})
export class WebhooksModule {}
