import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CLUSTER_EVENTS } from '../cluster/cluster-bus.service';
import { PbxConnection } from './entities/pbx-connection.entity';
import { Tenant } from './entities/tenant.entity';
import { CrmIntegration, CrmType } from './entities/crm-integration.entity';
import { CryptoService } from './crypto.service';

export interface ResolvedTenant {
  entity: Tenant;
  extensionRegex: RegExp;
}

/**
 * Local-only signal that this pod's registry copy is fresh. Deliberately not
 * mirrored across the cluster — each pod raises its own after reloading.
 */
export const REGISTRY_RELOADED = 'registry.reloaded';

/**
 * In-memory view of the tenant registry, loaded at boot. Phase 2 keeps this
 * static per process start; admin CRUD + hot reload arrive with the admin
 * UI (Phase 5) — reseeding + restart is the current workflow.
 */
@Injectable()
export class TenantRegistryService implements OnModuleInit {
  private readonly logger = new Logger(TenantRegistryService.name);
  private connections: PbxConnection[] = [];
  private tenants: ResolvedTenant[] = [];
  private byApiKeyHash = new Map<string, ResolvedTenant>();
  private integrations: CrmIntegration[] = [];

  constructor(
    @InjectRepository(PbxConnection) private readonly connectionRepo: Repository<PbxConnection>,
    @InjectRepository(Tenant) private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(CrmIntegration) private readonly integrationRepo: Repository<CrmIntegration>,
    private readonly crypto: CryptoService,
    private readonly bus: EventEmitter2,
  ) {}

  /**
   * A registry change made through /admin lands on one pod, but every pod
   * authenticates API keys and resolves tenants from its own in-memory copy.
   * Without this fan-out the other replicas answer 401 for a brand-new
   * tenant, and their delivery workers drop its jobs silently.
   *
   * Reload here first, then announce it locally so the PBX supervisors act on
   * fresh data rather than racing this listener.
   */
  @OnEvent(CLUSTER_EVENTS.registryReload)
  async onClusterReload(): Promise<void> {
    await this.onModuleInit();
    this.bus.emit(REGISTRY_RELOADED);
  }

  async onModuleInit(): Promise<void> {
    this.connections = await this.connectionRepo.find();
    const tenantEntities = await this.tenantRepo.find({ relations: { agents: true } });
    this.tenants = tenantEntities.map((entity) => ({
      entity,
      extensionRegex: new RegExp(entity.extensionPattern),
    }));
    this.byApiKeyHash = new Map(this.tenants.map((t) => [t.entity.apiKeyHash, t]));
    this.integrations = await this.integrationRepo.find();
    this.logger.log(
      `Registry loaded: ${this.connections.length} PBX connection(s), ` +
        `${this.tenants.length} tenant(s), ${this.integrations.length} CRM integration(s)`,
    );
  }

  /** Enabled CRM integration of the given type for a tenant, if any. */
  integrationFor(tenantSlug: string, type: CrmType): CrmIntegration | undefined {
    const tenant = this.tenantBySlug(tenantSlug);
    if (!tenant) return undefined;
    return this.integrations.find(
      (i) => i.tenantId === tenant.entity.id && i.type === type && i.enabled,
    );
  }

  /** Decrypts an integration's secrets blob ({ clientSecret, refreshToken, ... }). */
  integrationSecrets(integration: CrmIntegration): Record<string, string> {
    return JSON.parse(this.crypto.decrypt(integration.secretsEnc));
  }

  allConnections(): PbxConnection[] {
    return this.connections;
  }

  connectionById(id: string): PbxConnection | undefined {
    return this.connections.find((c) => c.id === id);
  }

  /** Tenant slugs served by a PBX connection (for wallboard broadcast). */
  tenantSlugsForConnection(connectionId: string): string[] {
    return this.tenants.filter((t) => t.entity.pbxConnectionId === connectionId).map((t) => t.entity.slug);
  }

  /** Resolves a reverse-mode connection from its connector token. */
  connectionByConnectorToken(token: string): PbxConnection | undefined {
    const hash = CryptoService.hashApiKey(token);
    return this.connections.find((c) => c.mode === 'reverse' && c.connectorTokenHash === hash);
  }

  amiSecretFor(connection: PbxConnection): string {
    return this.crypto.decrypt(connection.secretEnc);
  }

  webhookSecretFor(tenant: Tenant): string | null {
    return tenant.webhookSecretEnc ? this.crypto.decrypt(tenant.webhookSecretEnc) : null;
  }

  tenantByApiKey(apiKey: string): ResolvedTenant | undefined {
    return this.byApiKeyHash.get(CryptoService.hashApiKey(apiKey));
  }

  tenantBySlug(slug: string): ResolvedTenant | undefined {
    return this.tenants.find((t) => t.entity.slug === slug);
  }

  /**
   * Routes a call on a (possibly shared) PBX connection to its owning
   * tenant: dialplan context match first, then extension pattern, then the
   * connection's sole tenant if there is only one.
   */
  resolveTenantForCall(
    connectionId: string,
    hints: { context?: string; extensions: string[] },
  ): ResolvedTenant | undefined {
    const candidates = this.tenants.filter((t) => t.entity.pbxConnectionId === connectionId);
    if (candidates.length === 1) return candidates[0];

    if (hints.context) {
      const byContext = candidates.find((t) => t.entity.contexts.includes(hints.context!));
      if (byContext) return byContext;
    }
    for (const ext of hints.extensions) {
      const byExt = candidates.find((t) => t.extensionRegex.test(ext));
      if (byExt) return byExt;
    }
    return undefined;
  }
}
