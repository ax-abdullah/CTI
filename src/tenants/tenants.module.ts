import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PbxConnection } from './entities/pbx-connection.entity';
import { Tenant } from './entities/tenant.entity';
import { Agent } from './entities/agent.entity';
import { CryptoService } from './crypto.service';
import { TenantRegistryService } from './tenant-registry.service';

@Module({
  imports: [TypeOrmModule.forFeature([PbxConnection, Tenant, Agent])],
  providers: [CryptoService, TenantRegistryService],
  exports: [CryptoService, TenantRegistryService],
})
export class TenantsModule {}
