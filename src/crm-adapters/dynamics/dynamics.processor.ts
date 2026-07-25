import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';
import { DynamicsTokenService } from './dynamics-token.service';
import { DynamicsClient } from './dynamics-client';
import { DYNAMICS_QUEUE, DynamicsJob } from './dynamics.types';

/** Logs each completed call as a Dataverse phonecall activity. */
@Processor(DYNAMICS_QUEUE, { concurrency: 4 })
export class DynamicsProcessor extends WorkerHost {
  private readonly logger = new Logger(DynamicsProcessor.name);

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly tokens: DynamicsTokenService,
  ) {
    super();
  }

  async process(job: Job<DynamicsJob>): Promise<void> {
    const { tenantSlug, event } = job.data;
    const integration = this.registry.integrationFor(tenantSlug, 'dynamics');
    if (!integration) return;

    const tenant = this.registry.tenantBySlug(tenantSlug);
    const agent = tenant?.entity.agents?.find((a) => a.ext === event.agentExt);
    const ownerId = agent?.crmRefs?.dynamics;

    const accessToken = await this.tokens.accessTokenFor(integration);
    const client = new DynamicsClient(
      integration.config.orgUrl,
      integration.config.apiVersion ?? '9.2',
      accessToken,
    );

    try {
      const outgoing = event.direction === 'outbound';
      const id = await client.createPhoneCall({
        subject: `Call - ${outgoing ? 'Outbound' : 'Inbound'} - ${event.remoteNumber ?? 'unknown'}`,
        description: `Disposition ${event.disposition}, ${event.durationSec}s (talk ${event.billsecSec}s). CTI call ${event.callId}.`,
        directioncode: outgoing,
        actualdurationminutes: Math.max(1, Math.round(event.billsecSec / 60)),
        phonenumber: event.remoteNumber,
        ...(ownerId ? { 'ownerid@odata.bind': `/systemusers(${ownerId})` } : {}),
      });
      this.logger.log(`[${tenantSlug}] logged call ${event.callId} as Dynamics phonecall ${id}`);
    } catch (err) {
      if ((err as Error).message.includes('HTTP 401')) this.tokens.invalidate(integration.id);
      throw err;
    }
  }
}
