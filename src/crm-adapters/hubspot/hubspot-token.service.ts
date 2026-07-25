import { Injectable, Logger } from '@nestjs/common';
import { CrmIntegration } from '../../tenants/entities/crm-integration.entity';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * HubSpot OAuth2: a per-portal refresh token (from the app-install flow) is
 * exchanged for short-lived access tokens at {accountsBaseUrl}/oauth/v1/token.
 * Tokens are cached per integration and refreshed 60s before expiry.
 */
@Injectable()
export class HubSpotTokenService {
  private readonly logger = new Logger(HubSpotTokenService.name);
  private readonly cache = new Map<string, CachedToken>();

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
    const res = await fetch(`${integration.config.accountsBaseUrl}/oauth/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HubSpot token refresh failed: HTTP ${res.status}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };

    this.cache.set(integration.id, {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1_000,
    });
    this.logger.log(`Refreshed HubSpot access token for integration ${integration.id}`);
    return data.access_token;
  }

  invalidate(integrationId: string): void {
    this.cache.delete(integrationId);
  }
}
