import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Agent } from './tenants/entities/agent.entity';
import { CrmIntegration } from './tenants/entities/crm-integration.entity';
import { PbxConnection } from './tenants/entities/pbx-connection.entity';
import { Tenant } from './tenants/entities/tenant.entity';

/**
 * Single DataSource definition shared by the TypeORM CLI (migration
 * generate/run) and the seed script. The Nest app configures TypeORM
 * separately in app.module.ts but points at the same DB and migrations,
 * so `synchronize` is off everywhere — the schema is owned by migrations.
 *
 * Entities are listed explicitly (not a glob) so the same config works
 * from src/ under ts-node and from dist/ under node.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [PbxConnection, Tenant, Agent, CrmIntegration],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
});
