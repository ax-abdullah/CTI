import { Injectable, Logger } from '@nestjs/common';
import { CrmIntegration } from '../../tenants/entities/crm-integration.entity';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Dynamics 365 / Dataverse auth via Azure AD. Uses the client-credentials
 * grant (app registration with an application user in Dataverse) against
 * {loginBaseUrl}/{aadTenantId}/oauth2/v2.0/token, scope {orgUrl}/.default.
 */
@Injectable()
export class DynamicsTokenService {
  private readonly logger = new Logger(DynamicsTokenService.name);
  private readonly cache = new Map<string, CachedToken>();

  constructor(private readonly registry: TenantRegistryService) {}

  async accessTokenFor(integration: CrmIntegration): Promise<string> {
    const cached = this.cache.get(integration.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

    const secrets = this.registry.integrationSecrets(integration);
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: integration.config.clientId,
      client_secret: secrets.clientSecret,
      scope: `${integration.config.orgUrl}/.default`,
    });
    const url = `${integration.config.loginBaseUrl}/${integration.config.aadTenantId}/oauth2/v2.0/token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Dynamics token failed: HTTP ${res.status}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };

    this.cache.set(integration.id, {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1_000,
    });
    this.logger.log(`Refreshed Dynamics access token for integration ${integration.id}`);
    return data.access_token;
  }

  invalidate(integrationId: string): void {
    this.cache.delete(integrationId);
  }
}
