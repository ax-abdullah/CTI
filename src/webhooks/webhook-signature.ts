import { createHmac } from 'node:crypto';

/**
 * The webhook signature scheme, shared by the producer and documented for
 * consumers (scripts/webhook-receiver.mjs):
 *   X-CTI-Signature = hex( HMAC-SHA256( secret, `${timestamp}.${rawBody}` ) )
 * The signature covers the timestamp so replays past the 5-minute window a
 * consumer enforces cannot be re-signed.
 */
export function webhookSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}
