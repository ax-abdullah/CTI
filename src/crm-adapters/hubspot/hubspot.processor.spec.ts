import { Job } from 'bullmq';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';
import { HubSpotTokenService } from './hubspot-token.service';
import { HubSpotProcessor } from './hubspot.processor';
import { HubSpotJob } from './hubspot.types';

function makeProcessor(agentOwner?: string) {
  const integration = { id: 'int-1', config: { apiBaseUrl: 'http://hs.test' } } as any;
  const registry = {
    integrationFor: (slug: string, type: string) => (type === 'hubspot' ? integration : undefined),
    tenantBySlug: () => ({
      entity: { agents: [{ ext: '1001', crmRefs: agentOwner ? { hubspot: agentOwner } : {} }] },
    }),
  } as unknown as TenantRegistryService;
  const tokens = { accessTokenFor: async () => 'access-tok', invalidate: () => {} } as unknown as HubSpotTokenService;
  return new HubSpotProcessor(registry, tokens);
}

const endedJob = (): Job<HubSpotJob> =>
  ({
    data: {
      tenantSlug: 'tenant-a',
      event: {
        callId: 'c1',
        tenantId: 'tenant-a',
        direction: 'outbound',
        agentExt: '1001',
        remoteNumber: '+966501234567',
        disposition: 'ANSWERED',
        durationSec: 42,
        billsecSec: 40,
        startedAt: '2026-07-25T10:00:00.000Z',
        endedAt: '2026-07-25T10:00:42.000Z',
      },
    },
  }) as any;

describe('HubSpotProcessor', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'hs-call-9' }), { status: 201 }),
    );
  });
  afterEach(() => fetchMock.mockRestore());

  it('logs a completed call as a HubSpot Call engagement with mapped owner', async () => {
    await makeProcessor('owner-42').process(endedJob());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://hs.test/crm/v3/objects/calls');
    const body = JSON.parse((init as any).body);
    expect(body.properties).toMatchObject({
      hs_call_direction: 'OUTBOUND',
      hs_call_disposition: 'ANSWERED',
      hs_call_duration: 40000, // billsec -> ms
      hubspot_owner_id: 'owner-42',
      hs_call_to_number: '+966501234567',
    });
    expect((init as any).headers.Authorization).toBe('Bearer access-tok');
  });

  it('still logs when the agent has no HubSpot owner mapping', async () => {
    await makeProcessor().process(endedJob());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.properties.hubspot_owner_id).toBeUndefined();
  });

  it('propagates a failure so BullMQ retries', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(makeProcessor().process(endedJob())).rejects.toThrow(/HTTP 500/);
  });
});
