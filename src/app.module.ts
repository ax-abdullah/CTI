import { BullModule } from '@nestjs/bullmq';
import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule, REDIS_CLIENT } from './redis/redis.module';
import { ClusterModule } from './cluster/cluster.module';
import { CtiRole } from './cluster/cluster.types';
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
import { TelephonyModule } from './telephony/telephony.module';
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
        // NOT run at startup: N replicas booting together would race the same
        // DDL with no advisory lock to serialize them. Migrations are applied
        // once, ahead of the rollout, by `npm run migrate` (src/migrate.ts) —
        // a pre-upgrade Job in Kubernetes.
        migrationsRun: false,
        // Bounded per replica, because the pool multiplies by replica count:
        // 10 connections × 20 replicas exhausts a small managed Postgres.
        extra: { max: Number(config.get('DB_POOL_MAX', '10')) },
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
    ClusterModule,
    TenantsModule,
    ObservabilityModule,
  ],
})
export class AppModule {
  /**
   * One image, three roles (ADR-0012). Every role shares config, Postgres,
   * Redis, the cluster primitives and the observability surface; what differs
   * is which work it takes on:
   *
   * - `connector` — owns PBX sockets, derives call events, and is therefore
   *   the only role that enqueues delivery;
   * - `api` — HTTP and agent WebSockets; owns no PBX and routes commands to
   *   whichever replica does;
   * - `worker` — drains the delivery queues, scaling on queue depth;
   * - `all` — every role at once. The default, and what development, the
   *   compose stack and any pre-12b deployment run.
   *
   * Roles are additive rather than exclusive, so `all` is genuinely the union
   * and not a fourth code path to keep in step.
   */
  static forRole(role: CtiRole): DynamicModule {
    const serves = role === 'all' || role === 'api';

    const imports: DynamicModule['imports'] = [
      AppModule,
      // Call state is read by `api` (GET /v1/calls) and written by `connector`;
      // presence and queue stats likewise. All three read through Redis, so
      // loading them everywhere is correct rather than merely convenient.
      CallStateModule,
      PresenceModule,
      TelephonyModule,
      // The supervisors load for every role: on `api` they hold no connections
      // and act purely as the command-routing client. RecordingsModule brings
      // the connector file channel with it.
      PbxConnectorModule,
      RecordingsModule,
      WebhooksModule.forRole(role),
      ZohoModule.forRole(role),
      SalesforceModule.forRole(role),
      HubSpotModule.forRole(role),
      DynamicsModule.forRole(role),
    ];

    if (serves) imports.push(SoftphoneModule, AdminModule, ApiModule);

    return { module: AppRootModule, imports };
  }
}

/** Distinct root so `AppModule` itself can stay a plain imported module. */
@Module({})
export class AppRootModule {}
