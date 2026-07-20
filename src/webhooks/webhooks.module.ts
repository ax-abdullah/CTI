import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookProcessor } from './webhook.processor';
import { WEBHOOK_QUEUE } from './webhook.types';

@Module({
  imports: [BullModule.registerQueue({ name: WEBHOOK_QUEUE }), TenantsModule],
  providers: [WebhookDispatcherService, WebhookProcessor],
})
export class WebhooksModule {}
