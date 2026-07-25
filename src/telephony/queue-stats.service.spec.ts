import { EventEmitter2 } from '@nestjs/event-emitter';
import { AmiMessage } from '../pbx-connector/ami-client';
import { QueueStatsService, QUEUE_STATS_EVENT } from './queue-stats.service';

const CONN = 'conn-1';

function newService() {
  const bus = new EventEmitter2();
  const broadcasts: any[] = [];
  bus.on(QUEUE_STATS_EVENT, (s) => broadcasts.push(s));
  const svc = new QueueStatsService(bus);
  const feed = (msg: AmiMessage) => svc.onAmiEvent({ connectionId: CONN, msg });
  return { svc, feed, broadcasts };
}

describe('QueueStatsService', () => {
  it('tracks waiting callers, answered/abandoned, and averages', () => {
    const { svc, feed } = newService();
    feed({ Event: 'QueueCallerJoin', Queue: 'support', Count: '1' });
    feed({ Event: 'QueueCallerJoin', Queue: 'support', Count: '2' });
    feed({ Event: 'AgentConnect', Queue: 'support', HoldTime: '30' });   // answered, waited 30s
    feed({ Event: 'AgentComplete', Queue: 'support', TalkTime: '120' });
    feed({ Event: 'QueueCallerAbandon', Queue: 'support', Count: '0' }); // one gave up

    const [q] = svc.snapshot([CONN]);
    expect(q).toMatchObject({
      queue: 'support', waiting: 0, answered: 1, abandoned: 1, avgHoldSec: 30, avgTalkSec: 120,
    });
  });

  it('counts available members from QueueMemberStatus', () => {
    const { svc, feed } = newService();
    feed({ Event: 'QueueMemberStatus', Queue: 'support', MemberName: 'Agent/1001', Status: '1', Paused: '0' }); // available
    feed({ Event: 'QueueMemberStatus', Queue: 'support', MemberName: 'Agent/1002', Status: '2', Paused: '0' }); // in use
    feed({ Event: 'QueueMemberStatus', Queue: 'support', MemberName: 'Agent/1003', Status: '1', Paused: '1' }); // paused

    const [q] = svc.snapshot([CONN]);
    expect(q.membersTotal).toBe(3);
    expect(q.membersAvailable).toBe(1);
  });

  it('broadcasts on each update and isolates by connection', () => {
    const { svc, feed, broadcasts } = newService();
    feed({ Event: 'QueueCallerJoin', Queue: 'sales', Count: '1' });
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]).toMatchObject({ connectionId: CONN, queue: 'sales', waiting: 1 });
    expect(svc.snapshot(['other-conn'])).toEqual([]);
  });

  it('ignores non-queue events', () => {
    const { svc, feed } = newService();
    feed({ Event: 'Newchannel', Channel: 'PJSIP/1001-1' });
    expect(svc.snapshot()).toEqual([]);
  });
});
