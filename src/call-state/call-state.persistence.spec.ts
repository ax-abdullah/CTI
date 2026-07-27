import { EventEmitter2 } from '@nestjs/event-emitter';
import { AmiMessage } from '../pbx-connector/ami-client';
import { RecordingsService } from '../recordings/recordings.service';
import { ResolvedTenant, TenantRegistryService } from '../tenants/tenant-registry.service';
import { CallStateService } from './call-state.service';
import { CALL_EVENTS } from './normalized-events';

const CONN = 'conn-1';

function tenantA(): ResolvedTenant {
  return { entity: { slug: 'tenant-a', contexts: ['tenant-a-internal'] } as any, extensionRegex: /^1\d{3}$/ };
}

function registryWith(tenant: ResolvedTenant): TenantRegistryService {
  return {
    resolveTenantForCall: (_c: string, h: { context?: string; extensions: string[] }) =>
      h.context && tenant.entity.contexts.includes(h.context) ? tenant : undefined,
    tenantBySlug: (slug: string) => (slug === tenant.entity.slug ? tenant : undefined),
  } as unknown as TenantRegistryService;
}

/** A single shared in-memory Redis, so two services see the same store. */
function sharedRedis() {
  const store = new Map<string, string>();
  return {
    // Honours SET ... NX so the exactly-once finalize claim behaves as it
    // does in production (the first claimant wins, later ones get null).
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
    del: async (k: string) => void store.delete(k),
    scan: async (_cur: string, _m: string, pattern: string) => {
      const rx = new RegExp('^' + pattern.replace('*', '.*') + '$');
      return ['0', [...store.keys()].filter((k) => rx.test(k))];
    },
    mget: async (keys: string[]) => keys.map((k) => store.get(k) ?? null),
  };
}

const noRecordings = { signedUrlFor: () => undefined } as unknown as RecordingsService;

describe('CallStateService persistence + restart recovery', () => {
  /**
   * A lease handover can briefly leave two pods holding the same call: the
   * outgoing owner mid-hangup, and the incoming one having hydrated it from
   * Redis. Both would otherwise emit call.ended, and every enabled CRM would
   * log the call twice.
   */
  it('emits call.ended once when two pods finalize the same call', async () => {
    jest.useFakeTimers();
    const redis = sharedRedis() as any;
    const tenant = tenantA();

    const ended: unknown[] = [];
    const services = ['pod-a', 'pod-b'].map(() => {
      const bus = new EventEmitter2({ wildcard: true, delimiter: '.' });
      bus.on(CALL_EVENTS.ended, (e) => ended.push(e));
      return new CallStateService(registryWith(tenant), noRecordings, bus, redis);
    });

    // The same real call, observed independently by both pods.
    const newchannel: AmiMessage = {
      Event: 'Newchannel',
      Uniqueid: 'dup1',
      Linkedid: 'dup1',
      Channel: 'PJSIP/1001-000000dd',
      Context: 'tenant-a-internal',
    };
    for (const svc of services) {
      svc.handleAmiEvent({ connectionId: CONN, msg: newchannel });
      svc.handleAmiEvent({ connectionId: CONN, msg: { Event: 'Newstate', Linkedid: 'dup1', Uniqueid: 'dup1', ChannelStateDesc: 'Up' } });
      svc.handleAmiEvent({ connectionId: CONN, msg: { Event: 'Hangup', Linkedid: 'dup1', Uniqueid: 'dup1' } });
    }
    await jest.advanceTimersByTimeAsync(2000);

    expect(ended).toHaveLength(1);
    jest.useRealTimers();
  });

  it('recovers an in-flight call from Redis and finalizes it on hangup after "restart"', async () => {
    jest.useFakeTimers();
    const redis = sharedRedis() as any;

    // Instance 1: an answered call is in flight and persisted to Redis.
    const svc1 = new CallStateService(registryWith(tenantA()), noRecordings, new EventEmitter2(), redis);
    const feed1 = (msg: AmiMessage) => svc1.handleAmiEvent({ connectionId: CONN, msg });
    feed1({ Event: 'Newchannel', Uniqueid: 'c1', Linkedid: 'c1', Channel: 'PJSIP/1001-01', Context: 'tenant-a-internal', CallerIDNum: '0567' });
    feed1({ Event: 'BridgeEnter', Linkedid: 'c1', Uniqueid: 'c1' });

    // Instance 2 boots fresh (empty memory) but shares Redis — the restart.
    const bus2 = new EventEmitter2({ wildcard: true, delimiter: '.' });
    const ended: any[] = [];
    bus2.on(CALL_EVENTS.ended, (e) => ended.push(e));
    const svc2 = new CallStateService(registryWith(tenantA()), noRecordings, bus2, redis);

    return svc2.loadPersisted(CONN).then(async (records) => {
      expect(records).toHaveLength(1);
      expect(records[0].callId).toBe('c1');
      expect(records[0].tenant?.entity.slug).toBe('tenant-a'); // tenant re-resolved
      expect(records[0].answeredEmitted).toBe(true); // answered survived the restart

      // The hangup that arrives after restart still produces call.ended.
      svc2.handleAmiEvent({ connectionId: CONN, msg: { Event: 'Hangup', Linkedid: 'c1', Uniqueid: 'c1' } });
      await jest.advanceTimersByTimeAsync(2000);
      expect(ended).toHaveLength(1);
      expect(ended[0]).toMatchObject({ callId: 'c1', tenantId: 'tenant-a', disposition: 'ANSWERED' });
      jest.useRealTimers();
    });
  });
});
