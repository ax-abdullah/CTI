import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PbxConnectorModule } from './pbx-connector/pbx-connector.module';
import { CallStateModule } from './call-state/call-state.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ApiModule } from './api/api.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    PbxConnectorModule,
    CallStateModule,
    WebhooksModule,
    ApiModule,
  ],
})
export class AppModule {}
