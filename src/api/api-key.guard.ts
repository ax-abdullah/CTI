import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { TenantRegistryService } from '../tenants/tenant-registry.service';

/**
 * Resolves the calling tenant from X-API-Key (sha256 lookup in the
 * registry) and attaches it to the request. Every /v1 handler downstream
 * is therefore tenant-scoped by construction.
 */
@Injectable()
export class TenantApiKeyGuard implements CanActivate {
  constructor(private readonly registry: TenantRegistryService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const provided = request.headers['x-api-key'];
    const tenant = typeof provided === 'string' ? this.registry.tenantByApiKey(provided) : undefined;
    if (!tenant) throw new UnauthorizedException('Invalid API key');
    request.tenant = tenant;
    return true;
  }
}
