import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';
import { HubSpotTokenService } from './hubspot-token.service';
import { HubSpotClient } from './hubspot-client';
import { HUBSPOT_QUEUE, HubSpotJob } from './hubspot.types';

/** Logs each completed call as a HubSpot Call engagement owned by the mapped user. */
@Processor(HUBSPOT_QUEUE, { concurrency: 4 })
export class HubSpotProcessor extends WorkerHost {
  private readonly logger = new Logger(HubSpotProcessor.name);

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly tokens: HubSpotTokenService,
  ) {
    super();
  }

  async process(job: Job<HubSpotJob>): Promise<void> {
    const { tenantSlug, event } = job.data;
    const integration = this.registry.integrationFor(tenantSlug, 'hubspot');
    if (!integration) return;

    const tenant = this.registry.tenantBySlug(tenantSlug);
    const agent = tenant?.entity.agents?.find((a) => a.ext === event.agentExt);
    const ownerId = agent?.crmRefs?.hubspot;

    const accessToken = await this.tokens.accessTokenFor(integration);
    const client = new HubSpotClient(integration.config.apiBaseUrl, accessToken);

    try {
      const direction = event.direction === 'outbound' ? 'OUTBOUND' : 'INBOUND';
      const id = await client.createCall({
        hs_timestamp: event.endedAt,
        hs_call_direction: direction,
        hs_call_duration: event.billsecSec * 1000,
        hs_call_disposition: event.disposition,
        hs_call_from_number: direction === 'OUTBOUND' ? event.agentExt : event.remoteNumber,
        hs_call_to_number: direction === 'OUTBOUND' ? event.remoteNumber : event.agentExt,
        hs_call_status: 'COMPLETED',
        hubspot_owner_id: ownerId,
      });
      this.logger.log(`[${tenantSlug}] logged call ${event.callId} as HubSpot call ${id}`);
    } catch (err) {
      if ((err as Error).message.includes('HTTP 401')) this.tokens.invalidate(integration.id);
      throw err;
    }
  }
}
