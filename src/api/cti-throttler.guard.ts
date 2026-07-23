import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'node:crypto';

/**
 * Rate-limits the originate endpoints by *principal*, not by IP:
 *  - tenant API key  → per tenant   (`t:<hash>`)
 *  - agent bearer JWT → per session (`a:<hash>`)
 *  - otherwise        → per IP
 * Keying on the credential avoids any dependency on guard execution order
 * (we never need the request to be tenant-resolved first).
 */
@Injectable()
export class CtiThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const apiKey = req.headers?.['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length) {
      return `t:${createHash('sha256').update(apiKey).digest('hex')}`;
    }
    const auth = req.headers?.['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return `a:${createHash('sha256').update(auth.slice(7)).digest('hex')}`;
    }
    return req.ip ?? 'unknown';
  }
}
