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
    this.reload();
  }

  onModuleDestroy(): void {
    for (const connection of this.connections.values()) connection.stop();
  }

  /**
   * Diffs the (re)loaded registry against running connections: unchanged
   * ones keep running, changed ones are restarted, removed ones stopped,
   * new ones started. Called at boot and by POST /admin/reload.
   */
  reload(): void {
    const wanted = new Map(
      this.registry.allConnections().map((row) => {
        const connection = new SupervisedConnection(
          {
            connectionId: row.id,
            name: row.name,
            mode: row.mode,
            host: row.host,
            port: row.port,
            username: row.username,
            secret: this.registry.amiSecretFor(row),
          },
          this.bus,
        );
        return [row.id, connection] as const;
      }),
    );

    for (const [id, existing] of this.connections) {
      const replacement = wanted.get(id);
      if (replacement && replacement.fingerprint() === existing.fingerprint()) {
        wanted.delete(id); // unchanged — keep the live one
        continue;
      }
      existing.stop();
      this.connections.delete(id);
    }
    for (const [id, connection] of wanted) {
      this.connections.set(id, connection);
      connection.start();
    }
    this.logger.log(`Supervising ${this.connections.size} PBX connection(s)`);
  }

  /** Reverse-connector gateway hands authenticated tunnels over here. */
  attachReverseStream(connectionId: string, stream: import('node:stream').Duplex): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      stream.destroy();
      return Promise.resolve();
    }
    return connection.attachStream(stream);
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
