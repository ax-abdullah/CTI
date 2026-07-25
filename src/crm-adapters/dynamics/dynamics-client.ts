/**
 * Minimal Dataverse client: creates a phonecall activity for a completed
 * call via the Web API. Field names follow the standard phonecall entity;
 * the lab mock accepts this shape.
 */

export interface DynamicsPhoneCall {
  subject: string;
  description?: string;
  directioncode: boolean; // true = outgoing
  actualdurationminutes: number;
  phonenumber?: string;
  'ownerid@odata.bind'?: string; // /systemusers(<guid>)
}

export class DynamicsClient {
  constructor(
    private readonly orgUrl: string,
    private readonly apiVersion: string,
    private readonly accessToken: string,
  ) {}

  async createPhoneCall(activity: DynamicsPhoneCall): Promise<string> {
    const res = await fetch(`${this.orgUrl}/api/data/v${this.apiVersion}/phonecalls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
      },
      body: JSON.stringify(activity),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Dynamics phonecall create: HTTP ${res.status}`);
    // Dataverse returns the new id in the OData-EntityId header; the mock also
    // returns a JSON body { activityid }.
    const entityId = res.headers.get('OData-EntityId');
    if (entityId) return entityId;
    const data = (await res.json().catch(() => ({}))) as { activityid?: string };
    return data.activityid ?? 'created';
  }
}
