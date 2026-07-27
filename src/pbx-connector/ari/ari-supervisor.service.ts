import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { LeaseService } from '../../cluster/lease.service';
import { CTI_ROLE, CtiRole, roleOwnsPbx } from '../../cluster/cluster.types';
import { TenantRegistryService, REGISTRY_RELOADED } from '../../tenants/tenant-registry.service';
import { AriConnection, AriConnectionTarget } from './ari-connection';
import { AriClient } from './ari-client';
import { RoutingService } from './routing.service';

/**
 * Manages the ARI (Stasis) connections — those PbxConnection rows with
 * driver='ari' — alongside the AMI PbxSupervisorService. Additive by design:
 * the well-tested AMI path is untouched. Exposes each connection's AriClient
 * for supervisor coaching.
 *
 * Single ownership matters even more here than for AMI (ADR-0012). An ARI
 * connection does not merely observe: it answers channels, plays prompts, sets
 * variables and hands calls back to the dialplan. Two replicas in the same
 * Stasis app would each run that control flow against the same live channel.
 */
@Injectable()
export class AriSupervisorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AriSupervisorService.name);
  private readonly targets = new Map<string, AriConnectionTarget>();
  private readonly connections = new Map<string, AriConnection>();
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly routing: RoutingService,
    private readonly bus: EventEmitter2,
    private readonly leases: LeaseService,
    @Inject(CTI_ROLE) private readonly role: CtiRole,
  ) {}

  onModuleInit(): void {
    this.leases.onLost((kind, connectionId) => {
      if (kind === 'ami') this.standDown(connectionId);
    });
    this.reload();
    this.sweepTimer = setInterval(() => void this.sweep(), 5_000);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const c of this.connections.values()) c.stop();
    this.connections.clear();
  }

  private static fingerprint(t: AriConnectionTarget): string {
    return JSON.stringify([t.connectionId, t.name, t.baseUrl, t.app, t.username]);
  }

  /** Registry refreshed on this pod: re-diff our connections against it. */
  @OnEvent(REGISTRY_RELOADED)
  onRegistryReloaded(): void {
    this.reload();
  }

  /** Diff-reload ARI connections (mirrors PbxSupervisorService.reload). */
  reload(): void {
    this.targets.clear();
    for (const row of this.registry.allConnections()) {
      if (row.driver !== 'ari') continue;
      this.targets.set(row.id, {
        connectionId: row.id,
        name: row.name,
        baseUrl: `http://${row.host}:${row.port}`,
        username: row.username,
        password: this.registry.amiSecretFor(row),
        app: row.ariApp ?? 'cti',
      });
    }

    for (const [id, running] of [...this.connections]) {
      const target = this.targets.get(id);
      if (target && AriSupervisorService.fingerprint(target) === running.fingerprint()) continue;
      running.stop();
      this.connections.delete(id);
      if (!target) void this.leases.release('ami', id);
    }

    void this.sweep();
  }

  /** Start anything we can claim; a peer's loss becomes our gain on the next tick. */
  private async sweep(): Promise<void> {
    // Only a connector role may own PBX sockets (see PbxSupervisorService).
    if (!roleOwnsPbx(this.role)) return;

    for (const [id, target] of this.targets) {
      if (this.connections.has(id)) continue;
      if (!(await this.leases.tryAcquire('ami', id))) continue;
      const conn = new AriConnection(target, this.bus, this.registry, this.routing);
      this.connections.set(id, conn);
      conn.start();
      this.logger.log(`Supervising ARI ${target.name} (app ${target.app})`);
    }
  }

  /** Ownership moved: stop driving channels this pod no longer speaks for. */
  private standDown(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.stop();
    this.connections.delete(connectionId);
    this.logger.warn(`Stopped ARI ${connectionId}: ownership moved to another pod`);
  }

  /** The ARI client for a connection, for coaching / control (or undefined). */
  clientFor(connectionId: string): AriClient | undefined {
    return this.connections.get(connectionId)?.client;
  }

  statuses() {
    return [...this.connections.values()].map((c) => c.status());
  }
}
