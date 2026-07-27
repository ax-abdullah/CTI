import { EventEmitter2 } from '@nestjs/event-emitter';
import { AmiMessage } from '../pbx-connector/ami-client';
import { QueueStatsService, QUEUE_STATS_EVENT } from './queue-stats.service';

const CONN = 'conn-1';

/** In-memory Redis stub covering the get/set/scan/mget the service uses. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
    scan: async (_cursor: string, _m: string, pattern: string) => {
      const rx = new RegExp('^' + pattern.replace('*', '.*') + '$');
      return ['0', [...store.keys()].filter((k) => rx.test(k))];
    },
    mget: async (keys: string[]) => keys.map((k) => store.get(k) ?? null),
  };
}

function newService(redis = fakeRedis()) {
  const bus = new EventEmitter2();
  const broadcasts: any[] = [];
  bus.on(QUEUE_STATS_EVENT, (s) => broadcasts.push(s));
  const svc = new QueueStatsService(bus, redis as any);
  const feed = (msg: AmiMessage) => svc.onAmiEvent({ connectionId: CONN, msg });
  return { svc, feed, broadcasts, redis };
}

describe('QueueStatsService', () => {
  it('tracks waiting callers, answered/abandoned, and averages', async () => {
    const { svc, feed } = newService();
    await feed({ Event: 'QueueCallerJoin', Queue: 'support', Count: '1' });
    await feed({ Event: 'QueueCallerJoin', Queue: 'support', Count: '2' });
    await feed({ Event: 'AgentConnect', Queue: 'support', HoldTime: '30' });   // answered, waited 30s
    await feed({ Event: 'AgentComplete', Queue: 'support', TalkTime: '120' });
    await feed({ Event: 'QueueCallerAbandon', Queue: 'support', Count: '0' }); // one gave up

    const [q] = await svc.snapshot([CONN]);
    expect(q).toMatchObject({
      queue: 'support', waiting: 0, answered: 1, abandoned: 1, avgHoldSec: 30, avgTalkSec: 120,
    });
  });

  it('counts available members from QueueMemberStatus', async () => {
    const { svc, feed } = newService();
    await feed({ Event: 'QueueMemberStatus', Queue: 'support', MemberName: 'Agent/1001', Status: '1', Paused: '0' }); // available
    await feed({ Event: 'QueueMemberStatus', Queue: 'support', MemberName: 'Agent/1002', Status: '2', Paused: '0' }); // in use
    await feed({ Event: 'QueueMemberStatus', Queue: 'support', MemberName: 'Agent/1003', Status: '1', Paused: '1' }); // paused

    const [q] = await svc.snapshot([CONN]);
    expect(q.membersTotal).toBe(3);
    expect(q.membersAvailable).toBe(1);
  });

  it('broadcasts on each update and isolates by connection', async () => {
    const { svc, feed, broadcasts } = newService();
    await feed({ Event: 'QueueCallerJoin', Queue: 'sales', Count: '1' });
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]).toMatchObject({ connectionId: CONN, queue: 'sales', waiting: 1 });
    expect(await svc.snapshot(['other-conn'])).toEqual([]);
  });

  it('carries totals across an ownership handover instead of restarting at zero', async () => {
    // One shared Redis, two processes: the second is the pod that takes the
    // connection over after a rolling deploy or a crash.
    const redis = fakeRedis();
    const first = newService(redis);
    await first.feed({ Event: 'QueueCallerJoin', Queue: 'support', Count: '1' });
    await first.feed({ Event: 'AgentConnect', Queue: 'support', HoldTime: '20' });

    const second = newService(redis);

    // Reads correctly without ever having seen those events...
    const [before] = await second.svc.snapshot([CONN]);
    expect(before).toMatchObject({ answered: 1, avgHoldSec: 20 });

    // ...and keeps counting from there rather than resetting the wallboard.
    await second.feed({ Event: 'AgentConnect', Queue: 'support', HoldTime: '40' });
    const [after] = await second.svc.snapshot([CONN]);
    expect(after).toMatchObject({ answered: 2, avgHoldSec: 30 });
  });

  it('ignores non-queue events', async () => {
    const { svc, feed } = newService();
    await feed({ Event: 'Newchannel', Channel: 'PJSIP/1001-1' });
    expect(await svc.snapshot()).toEqual([]);
  });
});
