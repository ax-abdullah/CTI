import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';
import { SalesforceTokenService } from './salesforce-token.service';
import { SalesforceClient } from './salesforce-client';
import { SALESFORCE_QUEUE, SalesforceJob } from './salesforce.types';

/** Logs each completed call as a Salesforce Task owned by the mapped user. */
@Processor(SALESFORCE_QUEUE, { concurrency: 4 })
export class SalesforceProcessor extends WorkerHost {
  private readonly logger = new Logger(SalesforceProcessor.name);

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly tokens: SalesforceTokenService,
  ) {
    super();
  }

  async process(job: Job<SalesforceJob>): Promise<void> {
    const { tenantSlug, event } = job.data;
    const integration = this.registry.integrationFor(tenantSlug, 'salesforce');
    if (!integration) return;

    const tenant = this.registry.tenantBySlug(tenantSlug);
    const agent = tenant?.entity.agents?.find((a) => a.ext === event.agentExt);
    const ownerId = agent?.crmRefs?.salesforce;
    if (!ownerId) {
      this.logger.warn(
        `[${tenantSlug}] no Salesforce user mapped for ext ${event.agentExt ?? '?'}; call not logged`,
      );
      return;
    }

    const accessToken = await this.tokens.accessTokenFor(integration);
    const client = new SalesforceClient(
      integration.config.instanceUrl,
      integration.config.apiVersion ?? '61.0',
      accessToken,
    );

    try {
      const direction = event.direction === 'outbound' ? 'Outbound' : 'Inbound';
      const taskId = await client.createCallTask({
        Subject: `Call - ${direction} - ${event.remoteNumber ?? 'unknown'}`,
        Status: 'Completed',
        TaskSubtype: 'Call',
        CallType: direction,
        CallDurationInSeconds: event.billsecSec,
        ActivityDate: event.endedAt.slice(0, 10),
        OwnerId: ownerId,
        Description:
          `Disposition: ${event.disposition}. Duration ${event.durationSec}s ` +
          `(talk ${event.billsecSec}s). CTI call ${event.callId}.`,
      });
      this.logger.log(`[${tenantSlug}] logged call ${event.callId} as Task ${taskId}`);
    } catch (err) {
      if ((err as Error).message.includes('HTTP 401')) this.tokens.invalidate(integration.id);
      throw err;
    }
  }
}
