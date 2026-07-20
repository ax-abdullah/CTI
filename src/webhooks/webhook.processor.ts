import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { createHmac } from 'node:crypto';
import { TenantRegistryService } from '../tenants/tenant-registry.service';
import { WEBHOOK_QUEUE, WebhookJob } from './webhook.types';

/**
 * Consumer side: signs and POSTs each envelope to the owning tenant's
 * webhook endpoint. Signature contract (see README):
 *   X-CTI-Timestamp:  epoch ms
 *   X-CTI-Signature:  hex( HMAC-SHA256( tenantSecret, `${ts}.${rawBody}` ) )
 * Throwing rethrows into BullMQ's retry/backoff; the final failure stays in
 * Redis as a dead-letter (removeOnFail: false on the producer).
 */
@Processor(WEBHOOK_QUEUE, { concurrency: 8 })
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(private readonly registry: TenantRegistryService) {
    super();
  }

  async process(job: Job<WebhookJob>): Promise<void> {
    const { envelope } = job.data;
    const tenant = this.registry.tenantBySlug(envelope.tenantId);
    if (!tenant?.entity.webhookUrl) return; // tenant has no webhook configured

    const secret = this.registry.webhookSecretFor(tenant.entity);
    if (!secret) {
      this.logger.warn(`[${envelope.tenantId}] webhook URL set but no secret; skipping`);
      return;
    }

    const body = JSON.stringify(envelope);
    const timestamp = Date.now().toString();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const res = await fetch(tenant.entity.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CTI-Timestamp': timestamp,
        'X-CTI-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${tenant.entity.webhookUrl}`);
    }
    this.logger.log(
      `[${envelope.tenantId}] delivered ${envelope.type} (${envelope.id}, attempt ${job.attemptsMade + 1})`,
    );
  }
}
