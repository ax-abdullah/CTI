import { EventEmitter2 } from '@nestjs/event-emitter';
import { AmiMessage } from '../pbx-connector/ami-client';
import { RecordingsService } from '../recordings/recordings.service';
import { ResolvedTenant, TenantRegistryService } from '../tenants/tenant-registry.service';
import { CallStateService } from './call-state.service';
import { CALL_EVENTS } from './normalized-events';

const CONN = 'conn-1';

/** A tenant owning context `tenant-a-internal` and extensions 1xxx. */
function tenantA(): ResolvedTenant {
  return {
    entity: { slug: 'tenant-a', contexts: ['tenant-a-internal'] } as any,
    extensionRegex: /^1\d{3}$/,
  };
}

/** Minimal registry: resolves by context or extension, like the real one. */
function fakeRegistry(tenant: ResolvedTenant): TenantRegistryService {
  return {
    resolveTenantForCall: (_conn: string, hints: { context?: string; extensions: string[] }) => {
      if (hints.context && tenant.entity.contexts.includes(hints.context)) return tenant;
      if (hints.extensions.some((e) => tenant.extensionRegex.test(e))) return tenant;
      return undefined;
    },
  } as unknown as TenantRegistryService;
}

const noRecordings = { signedUrlFor: () => undefined } as unknown as RecordingsService;

/** In-memory Redis stub covering set/del/scan/mget used by CallStateService. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: async (k: string, v: string) => void store.set(k, v),
    del: async (k: string) => void store.delete(k),
    scan: async (_cursor: string, _m: string, pattern: string) => {
      const rx = new RegExp('^' + pattern.replace('*', '.*') + '$');
      return ['0', [...store.keys()].filter((k) => rx.test(k))];
    },
    mget: async (keys: string[]) => keys.map((k) => store.get(k) ?? null),
  };
}

function newService(registry: TenantRegistryService) {
  const bus = new EventEmitter2({ wildcard: true, delimiter: '.' });
  const events: { type: string; payload: any }[] = [];
  for (const type of Object.values(CALL_EVENTS)) {
    bus.on(type, (payload) => events.push({ type, payload }));
  }
  const redis = fakeRedis();
  const svc = new CallStateService(registry, noRecordings, bus, redis as any);
  const feed = (msg: AmiMessage) => svc.handleAmiEvent({ connectionId: CONN, msg });
  return { svc, events, feed, redis };
}

describe('CallStateService correlation', () => {
  jest.useFakeTimers();

  it('emits ringing -> answered -> ended for an inbound call', () => {
    const { events, feed } = newService(fakeRegistry(tenantA()));

    feed({ Event: 'Newchannel', Uniqueid: 'c1', Linkedid: 'c1', Channel: 'PJSIP/1001-00000001', Context: 'tenant-a-internal', CallerIDNum: '0567778888' });
    feed({ Event: 'DialBegin', Linkedid: 'c1', DestChannel: 'PJSIP/1001-00000001', DialString: '1001' });
    feed({ Event: 'BridgeEnter', Linkedid: 'c1', Uniqueid: 'c1' });
    feed({ Event: 'Hangup', Linkedid: 'c1', Uniqueid: 'c1' });
    jest.advanceTimersByTime(2000); // pass the finalize grace period

    const types = events.map((e) => e.type);
    expect(types).toEqual([CALL_EVENTS.ringing, CALL_EVENTS.answered, CALL_EVENTS.ended]);

    const ended = events.find((e) => e.type === CALL_EVENTS.ended)!.payload;
    expect(ended).toMatchObject({ callId: 'c1', tenantId: 'tenant-a', disposition: 'ANSWERED' });
    expect(ended.billsecSec).toBeGreaterThanOrEqual(0);
  });

  it('tags a call.ended with the callRef and outbound direction from CTI_CALL_REF', () => {
    const { events, feed } = newService(fakeRegistry(tenantA()));

    feed({ Event: 'Newchannel', Uniqueid: 'c2', Linkedid: 'c2', Channel: 'Local/1001@tenant-a-internal-00000002;1', Context: 'tenant-a-internal' });
    feed({ Event: 'VarSet', Linkedid: 'c2', Uniqueid: 'c2', Variable: 'CTI_CALL_REF', Value: 'ref-xyz' });
    feed({ Event: 'Newstate', Linkedid: 'c2', Uniqueid: 'c2', ChannelStateDesc: 'Up' });
    feed({ Event: 'Hangup', Linkedid: 'c2', Uniqueid: 'c2' });
    jest.advanceTimersByTime(2000);

    const ended = events.find((e) => e.type === CALL_EVENTS.ended)!.payload;
    expect(ended.callRef).toBe('ref-xyz');
    expect(ended.direction).toBe('outbound');
  });

  it('reports NO ANSWER when a dialed call is never answered', () => {
    const { events, feed } = newService(fakeRegistry(tenantA()));

    feed({ Event: 'Newchannel', Uniqueid: 'c3', Linkedid: 'c3', Channel: 'PJSIP/1002-00000003', Context: 'tenant-a-internal', CallerIDNum: '0560000000' });
    feed({ Event: 'DialEnd', Linkedid: 'c3', DialStatus: 'NOANSWER' });
    feed({ Event: 'Hangup', Linkedid: 'c3', Uniqueid: 'c3' });
    jest.advanceTimersByTime(2000);

    const ended = events.find((e) => e.type === CALL_EVENTS.ended)!.payload;
    expect(ended.disposition).toBe('NO ANSWER');
    expect(events.some((e) => e.type === CALL_EVENTS.answered)).toBe(false);
  });

  it('drops a call that matches no tenant (never delivered cross-tenant)', () => {
    // Registry that owns only 2xxx / tenant-b context; a 1xxx call must not leak.
    const other: ResolvedTenant = { entity: { slug: 'tenant-b', contexts: ['tenant-b-internal'] } as any, extensionRegex: /^2\d{3}$/ };
    const { events, feed } = newService(fakeRegistry(other));

    feed({ Event: 'Newchannel', Uniqueid: 'c4', Linkedid: 'c4', Channel: 'PJSIP/1001-00000004', Context: 'tenant-a-internal' });
    feed({ Event: 'Hangup', Linkedid: 'c4', Uniqueid: 'c4' });
    jest.advanceTimersByTime(2000);

    expect(events).toHaveLength(0);
  });

  it('emits nothing until all legs of a multi-leg call have hung up', () => {
    const { events, feed } = newService(fakeRegistry(tenantA()));

    feed({ Event: 'Newchannel', Uniqueid: 'a', Linkedid: 'a', Channel: 'PJSIP/1001-0000000a', Context: 'tenant-a-internal', CallerIDNum: '0567778888' });
    feed({ Event: 'Newchannel', Uniqueid: 'b', Linkedid: 'a', Channel: 'PJSIP/1002-0000000b', Context: 'tenant-a-internal' });
    feed({ Event: 'BridgeEnter', Linkedid: 'a', Uniqueid: 'a' });
    feed({ Event: 'Hangup', Linkedid: 'a', Uniqueid: 'a' }); // only one leg down
    jest.advanceTimersByTime(2000);
    expect(events.some((e) => e.type === CALL_EVENTS.ended)).toBe(false);

    feed({ Event: 'Hangup', Linkedid: 'a', Uniqueid: 'b' }); // second leg down
    jest.advanceTimersByTime(2000);
    expect(events.some((e) => e.type === CALL_EVENTS.ended)).toBe(true);
  });

  afterAll(() => jest.useRealTimers());
});
