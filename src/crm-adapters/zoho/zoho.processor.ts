import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';
import { ZohoTokenService } from './zoho-token.service';
import { ZohoClient } from './zoho-client';
import { ZOHO_QUEUE, ZohoJob } from './zoho.types';

/**
 * Consumer: translates normalized call events into PhoneBridge notifies.
 * Ringing creates the call in Zoho (which matches the number and pops the
 * contact for the mapped user); answered/ended update it — the ended update
 * is what makes Zoho log the call activity automatically.
 */
@Processor(ZOHO_QUEUE, { concurrency: 4 })
export class ZohoProcessor extends WorkerHost {
  private readonly logger = new Logger(ZohoProcessor.name);

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly tokens: ZohoTokenService,
  ) {
    super();
  }

  async process(job: Job<ZohoJob>): Promise<void> {
    const { tenantSlug } = job.data;
    const integration = this.registry.integrationFor(tenantSlug, 'zoho');
    if (!integration) return; // integration removed since enqueue

    const accessToken = await this.tokens.accessTokenFor(integration);
    const client = new ZohoClient(integration.config.apiBaseUrl, accessToken);

    try {
      await this.send(client, job.data, tenantSlug);
    } catch (err) {
      // A stale access token yields 401; drop the cache so the retry
      // (BullMQ backoff) starts with a fresh token.
      if ((err as Error).message.includes('HTTP 401')) this.tokens.invalidate(integration.id);
      throw err;
    }
    this.logger.log(`[${tenantSlug}] zoho ${job.data.kind} delivered (call ${job.data.event.callId})`);
  }

  private async send(client: ZohoClient, job: ZohoJob, tenantSlug: string): Promise<void> {
    switch (job.kind) {
      case 'ringing': {
        const { event } = job;
        const zohoUserId = this.zohoUserFor(tenantSlug, event.agentExt);
        if (!zohoUserId) {
          this.logger.warn(
            `[${tenantSlug}] no Zoho user mapped for ext ${event.agentExt ?? '?'}; skipping pop`,
          );
          return;
        }
        return client.notifyCall({
          callId: event.callId,
          callType: event.direction === 'outbound' ? 'outbound' : 'inbound',
          state: 'RINGING',
          from: event.direction === 'outbound' ? event.agentExt : event.remoteNumber,
          to: event.direction === 'outbound' ? event.remoteNumber : event.agentExt,
          zohoUserId,
          startTime: event.startedAt,
        });
      }
      case 'answered':
        return client.updateCall(job.event.callId, {
          state: 'ANSWERED',
          answeredAt: job.event.answeredAt,
        });
      case 'ended':
        return client.updateCall(job.event.callId, {
          state: 'ENDED',
          endedAt: job.event.endedAt,
          durationSec: job.event.durationSec,
          billsecSec: job.event.billsecSec,
          disposition: job.event.disposition,
        });
    }
  }

  private zohoUserFor(tenantSlug: string, agentExt?: string): string | undefined {
    if (!agentExt) return undefined;
    const tenant = this.registry.tenantBySlug(tenantSlug);
    const agent = tenant?.entity.agents?.find((a) => a.ext === agentExt);
    return agent?.crmRefs?.zoho;
  }
}
