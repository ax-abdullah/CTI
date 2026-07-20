/**
 * Thin HTTP client for the Zoho PhoneBridge call-notify API.
 *
 * NOTE: endpoint paths and payload field names follow Zoho's PhoneBridge v3
 * shape but must be reconciled against the partner documentation once the
 * PhoneBridge registration is approved (architecture doc §8.1). The lab
 * mock server (scripts/mock-zoho.mjs) speaks exactly this contract, so any
 * later adjustment is confined to this file + the mock.
 */

export interface ZohoCallNotify {
  callId: string;
  callType: 'inbound' | 'outbound';
  state: 'RINGING' | 'ANSWERED' | 'ENDED';
  from?: string;
  to?: string;
  zohoUserId: string;
  startTime: string;
}

export interface ZohoCallUpdate {
  state: 'ANSWERED' | 'ENDED';
  answeredAt?: string;
  endedAt?: string;
  durationSec?: number;
  billsecSec?: number;
  disposition?: string;
}

export class ZohoClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly accessToken: string,
  ) {}

  /** Ringing: creates the call in Zoho — Zoho matches + pops the contact. */
  notifyCall(payload: ZohoCallNotify): Promise<void> {
    return this.request('POST', '/calls', payload);
  }

  /** Answered/ended: updates the call card / logs the activity. */
  updateCall(callId: string, payload: ZohoCallUpdate): Promise<void> {
    return this.request('PUT', `/calls/${encodeURIComponent(callId)}`, payload);
  }

  private async request(method: string, path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Zoho-oauthtoken ${this.accessToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Zoho ${method} ${path}: HTTP ${res.status}`);
  }
}
