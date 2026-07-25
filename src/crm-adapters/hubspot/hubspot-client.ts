/**
 * Minimal HubSpot CRM client: creates a Call engagement for a completed
 * call. Payload follows the v3 objects API; reconcile property names with
 * the portal's schema when going live (the lab mock accepts this shape).
 */

export interface HubSpotCallProperties {
  hs_timestamp: string; // ISO or epoch ms
  hs_call_direction: 'INBOUND' | 'OUTBOUND';
  hs_call_duration: number; // milliseconds
  hs_call_disposition: string;
  hs_call_from_number?: string;
  hs_call_to_number?: string;
  hs_call_status: 'COMPLETED';
  hubspot_owner_id?: string;
}

export class HubSpotClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly accessToken: string,
  ) {}

  async createCall(properties: HubSpotCallProperties): Promise<string> {
    const res = await fetch(`${this.apiBaseUrl}/crm/v3/objects/calls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ properties }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HubSpot call create: HTTP ${res.status}`);
    const data = (await res.json()) as { id: string };
    return data.id;
  }
}
