import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { TenantRegistryService, ResolvedTenant } from '../tenants/tenant-registry.service';
import { SupervisedConnection } from './supervised-connection';

/**
 * Spawns one SupervisedConnection per PBX connection in the registry and
 * executes tenant-scoped Originate actions on the right connection.
 */
@Injectable()
export class PbxSupervisorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PbxSupervisorService.name);
  private readonly connections = new Map<string, SupervisedConnection>();

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly bus: EventEmitter2,
  ) {}

  onModuleInit(): void {
    for (const row of this.registry.allConnections()) {
      const connection = new SupervisedConnection(
        {
          connectionId: row.id,
          name: row.name,
          host: row.host,
          port: row.port,
          username: row.username,
          secret: this.registry.amiSecretFor(row),
        },
        this.bus,
      );
      this.connections.set(row.id, connection);
      connection.start();
    }
    this.logger.log(`Supervising ${this.connections.size} PBX connection(s)`);
  }

  onModuleDestroy(): void {
    for (const connection of this.connections.values()) connection.stop();
  }

  statuses() {
    return [...this.connections.values()].map((c) => c.status());
  }

  /** Click-to-call for a tenant: agent-leg-first on the tenant's PBX. */
  async originate(tenant: ResolvedTenant, agentExt: string, number: string): Promise<{ callRef: string }> {
    const connection = this.connections.get(tenant.entity.pbxConnectionId);
    if (!connection) throw new Error(`No PBX connection for tenant ${tenant.entity.slug}`);

    const callRef = randomUUID();
    const channel = tenant.entity.originateChannelTemplate.replaceAll('{ext}', agentExt);
    const res = await connection.sendAction({
      Action: 'Originate',
      Channel: channel,
      Context: tenant.entity.originateContext,
      Exten: number,
      Priority: '1',
      CallerID: `${number} <${number}>`,
      Timeout: '30000',
      Async: 'true',
      Variable: `CTI_CALL_REF=${callRef}`,
    });
    if (res.Response !== 'Success') {
      throw new Error(`Originate rejected: ${res.Message ?? 'unknown'}`);
    }
    this.logger.log(`[${tenant.entity.slug}] Originated ${channel} -> ${number} (ref ${callRef})`);
    return { callRef };
  }
}
