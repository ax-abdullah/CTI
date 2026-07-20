import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

/** Platform-operator auth (X-Admin-Key) — distinct from tenant API keys. */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const provided = context.switchToHttp().getRequest().headers['x-admin-key'];
    const expected = this.config.getOrThrow<string>('ADMIN_API_KEY');
    if (
      typeof provided !== 'string' ||
      provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
      throw new UnauthorizedException('Invalid admin key');
    }
    return true;
  }
}
