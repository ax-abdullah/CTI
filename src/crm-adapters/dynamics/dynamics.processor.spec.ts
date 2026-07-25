import { Job } from 'bullmq';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';
import { DynamicsTokenService } from './dynamics-token.service';
import { DynamicsProcessor } from './dynamics.processor';
import { DynamicsJob } from './dynamics.types';

function makeProcessor(owner?: string) {
  const integration = { id: 'int-1', config: { orgUrl: 'http://dyn.test', apiVersion: '9.2' } } as any;
  const registry = {
    integrationFor: (slug: string, type: string) => (type === 'dynamics' ? integration : undefined),
    tenantBySlug: () => ({ entity: { agents: [{ ext: '2001', crmRefs: owner ? { dynamics: owner } : {} }] } }),
  } as unknown as TenantRegistryService;
  const tokens = { accessTokenFor: async () => 'access-tok', invalidate: () => {} } as unknown as DynamicsTokenService;
  return new DynamicsProcessor(registry, tokens);
}

const endedJob = (): Job<DynamicsJob> =>
  ({
    data: {
      tenantSlug: 'tenant-b',
      event: {
        callId: 'c9', tenantId: 'tenant-b', direction: 'inbound', agentExt: '2001',
        remoteNumber: '0555555555', disposition: 'ANSWERED', durationSec: 130, billsecSec: 120,
        startedAt: '2026-07-25T10:00:00.000Z', endedAt: '2026-07-25T10:02:10.000Z',
      },
    },
  }) as any;

describe('DynamicsProcessor', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 204, headers: { 'OData-EntityId': 'http://dyn.test/api/data/v9.2/phonecalls(abc)' } }),
    );
  });
  afterEach(() => fetchMock.mockRestore());

  it('logs a completed call as a Dataverse phonecall with owner bind', async () => {
    await makeProcessor('11111111-1111-1111-1111-111111111111').process(endedJob());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://dyn.test/api/data/v9.2/phonecalls');
    const body = JSON.parse((init as any).body);
    expect(body).toMatchObject({
      directioncode: false, // inbound
      actualdurationminutes: 2, // 120s -> 2 min
      phonenumber: '0555555555',
      'ownerid@odata.bind': '/systemusers(11111111-1111-1111-1111-111111111111)',
    });
  });

  it('omits the owner bind when unmapped', async () => {
    await makeProcessor().process(endedJob());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body['ownerid@odata.bind']).toBeUndefined();
  });

  it('propagates a failure so BullMQ retries', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(makeProcessor().process(endedJob())).rejects.toThrow(/HTTP 500/);
  });
});
