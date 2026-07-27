import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PbxSupervisorService } from '../pbx-connector/pbx-supervisor.service';
import { AriSupervisorService } from '../pbx-connector/ari/ari-supervisor.service';
import { LeaseService } from '../cluster/lease.service';
import { SoftphoneGateway } from '../softphone/softphone.gateway';
import { WEBHOOK_QUEUE } from '../webhooks/webhook.types';
import { ZOHO_QUEUE } from '../crm-adapters/zoho/zoho.types';
import { SALESFORCE_QUEUE } from '../crm-adapters/salesforce/salesforce.types';
import { HUBSPOT_QUEUE } from '../crm-adapters/hubspot/hubspot.types';
import { DYNAMICS_QUEUE } from '../crm-adapters/dynamics/dynamics.types';
import { MetricsService } from './metrics.service';

/**
 * Feeds the gauge metrics (PBX connection state, queue depth) and doubles as
 * the alert source: on each poll, a connection that is down or a queue with
 * failed (dead-letter) jobs emits a structured WARN — the log line an
 * external alerting pipeline (or Prometheus Alertmanager, off the same
 * gauges) fires on. Edge-triggered so it doesn't spam every 5s.
 */
@Injectable()
export class MetricsCollectorsService implements OnModuleInit {
  private readonly logger = new Logger('Alerts');
  private downConnections = new Set<string>();
  private queuesWithFailures = new Set<string>();

  constructor(
    private readonly metrics: MetricsService,
    private readonly supervisor: PbxSupervisorService,
    private readonly ari: AriSupervisorService,
    private readonly leases: LeaseService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
    @InjectQueue(ZOHO_QUEUE) private readonly zohoQueue: Queue,
    @InjectQueue(SALESFORCE_QUEUE) private readonly salesforceQueue: Queue,
    @InjectQueue(HUBSPOT_QUEUE) private readonly hubspotQueue: Queue,
    @InjectQueue(DYNAMICS_QUEUE) private readonly dynamicsQueue: Queue,
    @Optional() private readonly softphone?: SoftphoneGateway,
  ) {}

  onModuleInit(): void {
    this.metrics.registerGaugeCollector(() => this.collectConnections());
    this.metrics.registerGaugeCollector(() => this.collectQueues());
    this.metrics.registerGaugeCollector(() => this.collectScaleSignals());
  }

  /**
   * Per-replica gauges that drive autoscaling (Phase 12b). Unlike
   * `cti_queue_jobs` these are local to this pod, so `sum()` across pods is
   * the true cluster figure.
   *
   * Each is optional at the DI level: on a `worker` replica there is no
   * softphone gateway, and asking for one would make the module graph depend
   * on a role it does not run.
   */
  private collectScaleSignals(): void {
    if (this.softphone) this.metrics.softphoneClients.set(this.softphone.clientCount());
    this.metrics.leasesHeld.set(this.leases.heldCount());
    for (const c of this.ari.statuses()) {
      this.metrics.ariConnectionUp.set({ connection: c.name }, c.connected ? 1 : 0);
    }
  }

  private collectConnections(): void {
    const stillDown = new Set<string>();
    for (const c of this.supervisor.statuses()) {
      this.metrics.connectionUp.set({ connection: c.name, mode: c.mode }, c.connected ? 1 : 0);
      if (!c.connected) {
        stillDown.add(c.name);
        if (!this.downConnections.has(c.name)) {
          this.logger.warn({ msg: 'alert', kind: 'pbx_connection_down', connection: c.name });
        }
      } else if (this.downConnections.has(c.name)) {
        this.logger.log({ msg: 'recovered', kind: 'pbx_connection_up', connection: c.name });
      }
    }
    this.downConnections = stillDown;
  }

  private async collectQueues(): Promise<void> {
    const queues: Array<[string, Queue]> = [
      ['webhook', this.webhookQueue],
      ['zoho', this.zohoQueue],
      ['salesforce', this.salesforceQueue],
      ['hubspot', this.hubspotQueue],
      ['dynamics', this.dynamicsQueue],
    ];
    const nowFailing = new Set<string>();
    for (const [name, queue] of queues) {
      const counts = await queue.getJobCounts();
      for (const [state, value] of Object.entries(counts)) {
        this.metrics.queueJobs.set({ queue: name, state }, value as number);
      }
      if ((counts.failed ?? 0) > 0) {
        nowFailing.add(name);
        if (!this.queuesWithFailures.has(name)) {
          this.logger.warn({ msg: 'alert', kind: 'dead_letters', queue: name, failed: counts.failed });
        }
      }
    }
    this.queuesWithFailures = nowFailing;
  }
}
