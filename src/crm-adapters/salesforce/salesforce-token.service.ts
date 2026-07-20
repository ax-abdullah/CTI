import { Injectable, Logger } from '@nestjs/common';
import { CrmIntegration } from '../../tenants/entities/crm-integration.entity';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Salesforce OAuth2 (per-org connected app): refresh-token grant against
 * {loginBaseUrl}/services/oauth2/token. Salesforce does not return
 * expires_in for this grant reliably, so tokens are cached for a fixed
 * conservative window and invalidated on 401.
 */
@Injectable()
export class SalesforceTokenService {
  private readonly logger = new Logger(SalesforceTokenService.name);
  private readonly cache = new Map<string, CachedToken>();
  private readonly cacheTtlMs = 30 * 60_000;

  constructor(private readonly registry: TenantRegistryService) {}

  async accessTokenFor(integration: CrmIntegration): Promise<string> {
    const cached = this.cache.get(integration.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

    const secrets = this.registry.integrationSecrets(integration);
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: integration.config.clientId,
      client_secret: secrets.clientSecret,
      refresh_token: secrets.refreshToken,
    });
    const res = await fetch(`${integration.config.loginBaseUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Salesforce token refresh failed: HTTP ${res.status}`);
    const data = (await res.json()) as { access_token: string };

    this.cache.set(integration.id, {
      accessToken: data.access_token,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    this.logger.log(`Refreshed Salesforce access token for integration ${integration.id}`);
    return data.access_token;
  }

  invalidate(integrationId: string): void {
    this.cache.delete(integrationId);
  }
}
