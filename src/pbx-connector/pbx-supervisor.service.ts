import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { ClusterRpcService } from '../cluster/cluster-rpc.service';
import { LeaseService } from '../cluster/lease.service';
import { TenantRegistryService, ResolvedTenant, REGISTRY_RELOADED } from '../tenants/tenant-registry.service';
import { SupervisedConnection, ConnectionTarget } from './supervised-connection';
import type { AmiMessage } from './ami-client';

/**
 * Owns the AMI connections this pod is responsible for, and routes commands
 * to the pod that owns the rest.
 *
 * A PBX connection is driven by exactly one replica at a time (ADR-0012):
 * without that, every replica runs its own correlation engine over the same
 * event stream and one call becomes N CRM records. Ownership is a Redis
 * lease — this service starts a connection only once it holds the lease, and
 * stops the moment it loses it.
 */
@Injectable()
export class PbxSupervisorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PbxSupervisorService.name);
  /** Every AMI connection in the registry, owned by us or not. */
  private readonly targets = new Map<string, ConnectionTarget>();
  /** The subset we hold the lease for and are actually running. */
  private readonly connections = new Map<string, SupervisedConnection>();
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly bus: EventEmitter2,
    private readonly leases: LeaseService,
    private readonly rpc: ClusterRpcService,
  ) {}

  onModuleInit(): void {
    this.leases.onLost((kind, connectionId) => {
      if (kind === 'ami') this.standDown(connectionId);
    });

    // Commands arriving from a pod that does not own the connection.
    this.rpc.register('pbx.originate', (id, slug: never, ext: never, number: never) =>
      this.originateLocal(id, slug, ext, number),
    );
    this.rpc.register('pbx.sendAction', (id, action: never) => this.sendActionLocal(id, action));
    this.rpc.register('pbx.showChannels', (id) => this.showChannelsLocal(id));

    this.reload();
    this.sweepTimer = setInterval(() => void this.sweep(), 5_000);
    this.sweepTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const connection of this.connections.values()) connection.stop();
    this.connections.clear();
  }

  /** Registry refreshed on this pod: re-diff our connections against it. */
  @OnEvent(REGISTRY_RELOADED)
  onRegistryReloaded(): void {
    this.reload();
  }

  /**
   * Refreshes the desired set from the registry. Connections whose config
   * changed are stopped so the next sweep restarts them; ones that vanished
   * are stopped and their lease released.
   *
   * Called at boot and by POST /admin/reload — which now reaches every pod
   * over the cluster bus, not just the one the request landed on.
   */
  reload(): void {
    this.targets.clear();
    for (const row of this.registry.allConnections()) {
      // ARI rows are driven by AriSupervisorService; pointing an AMI client
      // at the ARI HTTP port would just fail in a loop.
      if (row.driver === 'ari') continue;
      this.targets.set(row.id, {
        connectionId: row.id,
        name: row.name,
        mode: row.mode,
        host: row.host,
        port: row.port,
        username: row.username,
        secret: this.registry.amiSecretFor(row),
      });
    }

    for (const [id, running] of [...this.connections]) {
      const target = this.targets.get(id);
      if (target && SupervisedConnection.fingerprintOf(target) === running.fingerprint()) continue;
      running.stop();
      this.connections.delete(id);
      if (!target) void this.leases.release('ami', id);
    }

    void this.sweep();
  }

  /**
   * Claim anything unowned and start it. Runs on a timer so a connection
   * orphaned by a crashed pod is picked up within a lease TTL, and a pod that
   * joins the cluster takes its share without anyone coordinating.
   */
  private async sweep(): Promise<void> {
    for (const [id, target] of this.targets) {
      if (this.connections.has(id)) continue;
      // A reverse connection is only serveable where its tunnel landed, so
      // it is claimed on tunnel arrival rather than swept for.
      if (target.mode === 'reverse') continue;
      if (!(await this.leases.tryAcquire('ami', id))) continue;
      this.start(target);
    }
    this.logger.debug(`Supervising ${this.connections.size}/${this.targets.size} AMI connection(s)`);
  }

  private start(target: ConnectionTarget): SupervisedConnection {
    const connection = new SupervisedConnection(target, this.bus);
    this.connections.set(target.connectionId, connection);
    connection.start();
    this.logger.log(`Supervising ${target.name} (${target.mode})`);
    return connection;
  }

  /** Lease lost mid-flight: another pod now owns this PBX, so stop at once. */
  private standDown(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.stop();
    this.connections.delete(connectionId);
    this.logger.warn(`Stopped ${connectionId}: ownership moved to another pod`);
  }

  /**
   * The reverse connector dialled in here. The tunnel is the connection —
   * it can only be served by this pod — so ownership follows the socket and
   * any previous holder (which has no tunnel) stands down.
   */
  async attachReverseStream(connectionId: string, stream: import('node:stream').Duplex): Promise<void> {
    const target = this.targets.get(connectionId);
    if (!target) {
      stream.destroy();
      return;
    }
    await this.leases.forceClaim('ami', connectionId);
    const connection = this.connections.get(connectionId) ?? this.start(target);
    return connection.attachStream(stream);
  }

  statuses() {
    return [...this.connections.values()].map((c) => c.status());
  }

  hasConnection(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  /** Live channel list from a connection (for resync on reconnect). */
  async showChannels(connectionId: string): Promise<AmiMessage[]> {
    if (this.connections.has(connectionId)) return this.showChannelsLocal(connectionId);
    return this.rpc.call<AmiMessage[]>('ami', connectionId, 'pbx.showChannels');
  }

  private async showChannelsLocal(connectionId: string): Promise<AmiMessage[]> {
    const connection = this.connections.get(connectionId);
    if (!connection) return [];
    return connection.sendEventAction({ Action: 'CoreShowChannels' }, 'CoreShowChannelsComplete');
  }

  /** Send a raw AMI action on a connection (e.g. ChanSpy Originate for coaching). */
  async sendAction(connectionId: string, action: AmiMessage): Promise<AmiMessage> {
    if (this.connections.has(connectionId)) return this.sendActionLocal(connectionId, action);
    return this.rpc.call<AmiMessage>('ami', connectionId, 'pbx.sendAction', action);
  }

  private async sendActionLocal(connectionId: string, action: AmiMessage): Promise<AmiMessage> {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error(`No PBX connection ${connectionId}`);
    return connection.sendAction(action);
  }

  /**
   * Click-to-call for a tenant: agent-leg-first on the tenant's PBX. Runs
   * here if we own the connection, otherwise on the pod that does — which is
   * what makes click-to-call work on a replica that is not holding the
   * customer's reverse tunnel.
   */
  async originate(tenant: ResolvedTenant, agentExt: string, number: string): Promise<{ callRef: string }> {
    const connectionId = tenant.entity.pbxConnectionId;
    if (this.connections.has(connectionId)) {
      return this.originateLocal(connectionId, tenant.entity.slug, agentExt, number);
    }
    return this.rpc.call<{ callRef: string }>(
      'ami',
      connectionId,
      'pbx.originate',
      tenant.entity.slug,
      agentExt,
      number,
    );
  }

  private async originateLocal(
    connectionId: string,
    tenantSlug: string,
    agentExt: string,
    number: string,
  ): Promise<{ callRef: string }> {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error(`No PBX connection ${connectionId}`);
    // Re-resolved here rather than sent over the wire: the tenant carries a
    // compiled RegExp and decrypted secrets that must not be serialized.
    const tenant = this.registry.tenantBySlug(tenantSlug);
    if (!tenant) throw new Error(`Unknown tenant ${tenantSlug}`);

    const callRef = randomUUID();
    const channel = tenant.entity.originateChannelTemplate.replaceAll('{ext}', agentExt);
    const startedAt = Date.now();
    const report = (result: 'success' | 'rejected' | 'error') =>
      this.bus.emit('originate.result', {
        tenant: tenant.entity.slug,
        result,
        durationSec: (Date.now() - startedAt) / 1000,
      });

    try {
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
        report('rejected');
        throw new Error(`Originate rejected: ${res.Message ?? 'unknown'}`);
      }
      report('success');
      this.logger.log(`[${tenant.entity.slug}] Originated ${channel} -> ${number} (ref ${callRef})`);
      return { callRef };
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith('Originate rejected'))) report('error');
      throw err;
    }
  }
}
