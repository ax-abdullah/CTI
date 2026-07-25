import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule, REDIS_CLIENT } from './redis/redis.module';
import { TenantsModule } from './tenants/tenants.module';
import { PbxConnectorModule } from './pbx-connector/pbx-connector.module';
import { CallStateModule } from './call-state/call-state.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ZohoModule } from './crm-adapters/zoho/zoho.module';
import { SalesforceModule } from './crm-adapters/salesforce/salesforce.module';
import { HubSpotModule } from './crm-adapters/hubspot/hubspot.module';
import { DynamicsModule } from './crm-adapters/dynamics/dynamics.module';
import { SoftphoneModule } from './softphone/softphone.module';
import { PresenceModule } from './presence/presence.module';
import { RecordingsModule } from './recordings/recordings.module';
import { ObservabilityModule } from './observability/observability.module';
import { AdminModule } from './admin/admin.module';
import { ApiModule } from './api/api.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: false, // schema owned by migrations (src/migrations)
        migrations: [__dirname + '/migrations/*.js'],
        migrationsRun: true, // apply pending migrations at startup
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: Number(config.getOrThrow<string>('REDIS_PORT')),
        },
      }),
    }),
    // Default throttler == the originate limit; applied only where the
    // CtiThrottlerGuard is used (the two originate endpoints). Redis-backed
    // so limits are correct across instances.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: (config: ConfigService, redis: any) => ({
        throttlers: [
          {
            ttl: Number(config.get('ORIGINATE_RATE_TTL_SEC', '60')) * 1000,
            limit: Number(config.get('ORIGINATE_RATE_LIMIT', '30')),
          },
        ],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
    RedisModule,
    TenantsModule,
    PbxConnectorModule,
    CallStateModule,
    WebhooksModule,
    ZohoModule,
    SalesforceModule,
    HubSpotModule,
    DynamicsModule,
    SoftphoneModule,
    PresenceModule,
    RecordingsModule,
    ObservabilityModule,
    AdminModule,
    ApiModule,
  ],
})
export class AppModule {}
