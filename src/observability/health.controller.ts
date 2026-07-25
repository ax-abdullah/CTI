import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Orchestrator probes, distinct from the human-facing GET /health (which
 * reports PBX connection state). Liveness = the process serves; Readiness =
 * the backing stores are reachable, so a broker won't route traffic to an
 * instance that can't persist state. PBX-down does NOT fail readiness — the
 * API and webhooks still function.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @ApiExcludeEndpoint()
  @Get('live')
  live() {
    return { status: 'live' };
  }

  @ApiOperation({ summary: 'Readiness: Postgres + Redis reachable (200) else 503' })
  @Get('ready')
  async ready() {
    const checks = { postgres: false, redis: false };
    try {
      await this.db.query('SELECT 1');
      checks.postgres = true;
    } catch {
      /* stays false */
    }
    try {
      checks.redis = (await this.redis.ping()) === 'PONG';
    } catch {
      /* stays false */
    }
    if (!checks.postgres || !checks.redis) {
      throw new ServiceUnavailableException({ status: 'not-ready', checks });
    }
    return { status: 'ready', checks };
  }
}
