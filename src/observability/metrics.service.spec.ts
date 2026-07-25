import { MetricsService } from './metrics.service';
import { CALL_EVENTS } from '../call-state/normalized-events';

describe('MetricsService', () => {
  let svc: MetricsService;

  beforeEach(() => {
    svc = new MetricsService();
  });
  afterEach(() => svc.onModuleDestroy());

  it('counts completed calls by tenant/direction/disposition', async () => {
    svc.onEnded({ tenantId: 'tenant-a', direction: 'inbound', disposition: 'ANSWERED' } as any);
    svc.onEnded({ tenantId: 'tenant-a', direction: 'inbound', disposition: 'ANSWERED' } as any);
    svc.onEnded({ tenantId: 'tenant-b', direction: 'outbound', disposition: 'NO ANSWER' } as any);

    const text = await svc.expose();
    expect(text).toContain(
      'cti_calls_total{tenant="tenant-a",direction="inbound",disposition="ANSWERED"} 2',
    );
    expect(text).toContain(
      'cti_calls_total{tenant="tenant-b",direction="outbound",disposition="NO ANSWER"} 1',
    );
  });

  it('counts normalized call events by type', async () => {
    svc.onRinging({} as any);
    svc.onAnswered();
    svc.onEnded({ tenantId: 't', direction: 'inbound', disposition: 'ANSWERED' } as any);
    const text = await svc.expose();
    expect(text).toContain('cti_call_events_total{type="ringing"} 1');
    expect(text).toContain('cti_call_events_total{type="answered"} 1');
    expect(text).toContain('cti_call_events_total{type="ended"} 1');
  });

  it('records originate result counter and latency histogram', async () => {
    svc.onOriginate({ tenant: 'tenant-a', result: 'success', durationSec: 0.12 });
    const text = await svc.expose();
    expect(text).toContain('cti_originate_total{tenant="tenant-a",result="success"} 1');
    expect(text).toContain('cti_originate_duration_seconds_count{tenant="tenant-a",result="success"} 1');
  });

  it('runs registered gauge collectors on expose', async () => {
    let collected = 0;
    svc.registerGaugeCollector(() => {
      collected++;
      svc.connectionUp.set({ connection: 'lab', mode: 'direct' }, 1);
    });
    const text = await svc.expose();
    expect(collected).toBeGreaterThan(0);
    expect(text).toContain('cti_pbx_connection_up{connection="lab",mode="direct"} 1');
  });
});
