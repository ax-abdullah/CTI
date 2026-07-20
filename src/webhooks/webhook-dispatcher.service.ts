import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { createHmac, randomUUID } from 'node:crypto';
import { CALL_EVENTS } from '../call-state/normalized-events';

interface WebhookEnvelope {
  id: string;
  type: (typeof CALL_EVENTS)[keyof typeof CALL_EVENTS];
  tenantId: string;
  occurredAt: string;
  data: unknown;
}

/**
 * Generic-CRM surface: delivers every normalized call event as a signed
 * HTTP POST. Signature scheme (documented for webhook consumers):
 *
 *   X-CTI-Timestamp:  unix epoch milliseconds
 *   X-CTI-Signature:  hex( HMAC-SHA256( secret, `${timestamp}.${rawBody}` ) )
 *
 * Consumers must reject requests older than 5 minutes and compare the
 * signature in constant time.
 *
 * Phase 1: in-process retries with backoff, failures logged as dead letters.
 * Phase 2 replaces this with BullMQ (durable, per-tenant queues).
 */
@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly retryDelaysMs = [0, 2_000, 8_000];

  constructor(private readonly config: ConfigService) {}

  @OnEvent(CALL_EVENTS.ringing)
  onRinging(payload: { tenantId: string }): Promise<void> {
    return this.enqueue(CALL_EVENTS.ringing, payload);
  }

  @OnEvent(CALL_EVENTS.answered)
  onAnswered(payload: { tenantId: string }): Promise<void> {
    return this.enqueue(CALL_EVENTS.answered, payload);
  }

  @OnEvent(CALL_EVENTS.ended)
  onEnded(payload: { tenantId: string }): Promise<void> {
    return this.enqueue(CALL_EVENTS.ended, payload);
  }

  private enqueue(type: WebhookEnvelope['type'], payload: { tenantId: string }): Promise<void> {
    return this.deliver({
      id: randomUUID(),
      type,
      tenantId: payload.tenantId,
      occurredAt: new Date().toISOString(),
      data: payload,
    });
  }

  private async deliver(envelope: WebhookEnvelope): Promise<void> {
    const url = this.config.get<string>('WEBHOOK_URL');
    const secret = this.config.get<string>('WEBHOOK_SECRET');
    if (!url || !secret) return; // webhooks not configured for this tenant

    const body = JSON.stringify(envelope);
    for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt++) {
      if (this.retryDelaysMs[attempt] > 0) {
        await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
      }
      try {
        const timestamp = Date.now().toString();
        const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CTI-Timestamp': timestamp,
            'X-CTI-Signature': signature,
          },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          this.logger.log(`Delivered ${envelope.type} (${envelope.id}) -> ${url}`);
          return;
        }
        this.logger.warn(`Webhook ${envelope.id} got HTTP ${res.status} (attempt ${attempt + 1})`);
      } catch (err) {
        this.logger.warn(`Webhook ${envelope.id} failed: ${(err as Error).message} (attempt ${attempt + 1})`);
      }
    }
    // Dead letter — Phase 2 persists these and alerts.
    this.logger.error(`DEAD-LETTER ${envelope.type} ${envelope.id}: ${body}`);
  }
}
