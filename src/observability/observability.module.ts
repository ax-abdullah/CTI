import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PbxConnectorModule } from '../pbx-connector/pbx-connector.module';
import { WEBHOOK_QUEUE } from '../webhooks/webhook.types';
import { ZOHO_QUEUE } from '../crm-adapters/zoho/zoho.types';
import { SALESFORCE_QUEUE } from '../crm-adapters/salesforce/salesforce.types';
import { HUBSPOT_QUEUE } from '../crm-adapters/hubspot/hubspot.types';
import { DYNAMICS_QUEUE } from '../crm-adapters/dynamics/dynamics.types';
import { MetricsService } from './metrics.service';
import { MetricsCollectorsService } from './metrics-collectors.service';
import { MetricsController } from './metrics.controller';
import { HealthController } from './health.controller';
import { HttpLoggingInterceptor } from './http-logging.interceptor';

@Module({
  imports: [
    PbxConnectorModule,
    BullModule.registerQueue(
      { name: WEBHOOK_QUEUE },
      { name: ZOHO_QUEUE },
      { name: SALESFORCE_QUEUE },
      { name: HUBSPOT_QUEUE },
      { name: DYNAMICS_QUEUE },
    ),
  ],
  providers: [
    MetricsService,
    MetricsCollectorsService,
    // Registered here rather than via app.useGlobalInterceptors() so it can
    // inject MetricsService — a manually constructed interceptor gets no DI.
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
  ],
  controllers: [MetricsController, HealthController],
  exports: [MetricsService],
})
export class ObservabilityModule {}
