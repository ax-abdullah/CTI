import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import {
  CALL_EVENTS,
  CallEndedEvent,
  CallRingingEvent,
} from '../call-state/normalized-events';

/**
 * Prometheus metrics for the CTI. Counters/histograms are updated inline
 * from the normalized event bus and the originate path; gauges (connection
 * up/down, queue depth) are refreshed on a timer via registered collectors
 * so /metrics always reflects current state without per-scrape work.
 */
@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  readonly registry = new Registry();

  readonly calls = new Counter({
    name: 'cti_calls_total',
    help: 'Completed calls by tenant, direction, disposition',
    labelNames: ['tenant', 'direction', 'disposition'],
    registers: [this.registry],
  });
  readonly callEvents = new Counter({
    name: 'cti_call_events_total',
    help: 'Normalized call.* events emitted',
    labelNames: ['type'],
    registers: [this.registry],
  });
  readonly originates = new Counter({
    name: 'cti_originate_total',
    help: 'Click-to-call originate attempts by result',
    labelNames: ['tenant', 'result'],
    registers: [this.registry],
  });
  readonly originateDuration = new Histogram({
    name: 'cti_originate_duration_seconds',
    help: 'Latency of the AMI Originate action',
    labelNames: ['tenant', 'result'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });
  readonly connectionUp = new Gauge({
    name: 'cti_pbx_connection_up',
    help: 'PBX connection state (1 up, 0 down)',
    labelNames: ['connection', 'mode'],
    registers: [this.registry],
  });
  readonly queueJobs = new Gauge({
    name: 'cti_queue_jobs',
    help: 'BullMQ job counts by queue and state',
    labelNames: ['queue', 'state'],
    registers: [this.registry],
  });

  private readonly gaugeCollectors: Array<() => Promise<void> | void> = [];
  private timer?: NodeJS.Timeout;

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry, prefix: 'cti_' });
    this.timer = setInterval(() => void this.refreshGauges(), 5_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Register a source of gauge values, polled every 5s (and on scrape). */
  registerGaugeCollector(fn: () => Promise<void> | void): void {
    this.gaugeCollectors.push(fn);
  }

  async refreshGauges(): Promise<void> {
    for (const collect of this.gaugeCollectors) {
      try {
        await collect();
      } catch {
        /* a failing collector must not break the scrape */
      }
    }
  }

  async expose(): Promise<string> {
    await this.refreshGauges();
    return this.registry.metrics();
  }

  // ---- inline updates from the event pipeline ----

  @OnEvent(CALL_EVENTS.ringing)
  onRinging(e: CallRingingEvent): void {
    this.callEvents.inc({ type: 'ringing' });
  }

  @OnEvent(CALL_EVENTS.answered)
  onAnswered(): void {
    this.callEvents.inc({ type: 'answered' });
  }

  @OnEvent(CALL_EVENTS.ended)
  onEnded(e: CallEndedEvent): void {
    this.callEvents.inc({ type: 'ended' });
    this.calls.inc({ tenant: e.tenantId, direction: e.direction, disposition: e.disposition });
  }

  @OnEvent('originate.result')
  onOriginate(e: { tenant: string; result: string; durationSec: number }): void {
    this.originates.inc({ tenant: e.tenant, result: e.result });
    this.originateDuration.observe({ tenant: e.tenant, result: e.result }, e.durationSec);
  }
}
