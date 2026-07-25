import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';
import { AriConnection } from './ari-connection';
import { AriClient } from './ari-client';
import { RoutingService } from './routing.service';

/**
 * Manages the ARI (Stasis) connections — those PbxConnection rows with
 * driver='ari' — alongside the AMI PbxSupervisorService. Additive by design:
 * the well-tested AMI path is untouched. Exposes each connection's AriClient
 * for supervisor coaching.
 */
@Injectable()
export class AriSupervisorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AriSupervisorService.name);
  private readonly connections = new Map<string, AriConnection>();

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly routing: RoutingService,
    private readonly bus: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.reload();
  }

  onModuleDestroy(): void {
    for (const c of this.connections.values()) c.stop();
  }

  /** Diff-reload ARI connections (mirrors PbxSupervisorService.reload). */
  reload(): void {
    const wanted = new Map(
      this.registry
        .allConnections()
        .filter((row) => row.driver === 'ari')
        .map((row) => {
          const conn = new AriConnection(
            {
              connectionId: row.id,
              name: row.name,
              baseUrl: `http://${row.host}:${row.port}`,
              username: row.username,
              password: this.registry.amiSecretFor(row),
              app: row.ariApp ?? 'cti',
            },
            this.bus,
            this.registry,
            this.routing,
          );
          return [row.id, conn] as const;
        }),
    );

    for (const [id, existing] of this.connections) {
      const replacement = wanted.get(id);
      if (replacement && replacement.fingerprint() === existing.fingerprint()) {
        wanted.delete(id);
        continue;
      }
      existing.stop();
      this.connections.delete(id);
    }
    for (const [id, conn] of wanted) {
      this.connections.set(id, conn);
      conn.start();
    }
    if (this.connections.size) this.logger.log(`Supervising ${this.connections.size} ARI connection(s)`);
  }

  /** The ARI client for a connection, for coaching / control (or undefined). */
  clientFor(connectionId: string): AriClient | undefined {
    return this.connections.get(connectionId)?.client;
  }

  statuses() {
    return [...this.connections.values()].map((c) => c.status());
  }
}
