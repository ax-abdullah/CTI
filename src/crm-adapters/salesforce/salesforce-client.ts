/**
 * Minimal Salesforce REST client for what the CTI needs: creating Task
 * records of type Call. instanceUrl/apiVersion come from the integration
 * config (the lab mock speaks the same contract).
 */

export interface SalesforceCallTask {
  Subject: string;
  Status: 'Completed';
  TaskSubtype: 'Call';
  CallType: 'Inbound' | 'Outbound';
  CallDurationInSeconds: number;
  ActivityDate: string; // YYYY-MM-DD
  OwnerId: string;
  Description?: string;
}

export class SalesforceClient {
  constructor(
    private readonly instanceUrl: string,
    private readonly apiVersion: string,
    private readonly accessToken: string,
  ) {}

  async createCallTask(task: SalesforceCallTask): Promise<string> {
    const res = await fetch(
      `${this.instanceUrl}/services/data/v${this.apiVersion}/sobjects/Task`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(task),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) throw new Error(`Salesforce Task create: HTTP ${res.status}`);
    const data = (await res.json()) as { id: string };
    return data.id;
  }
}
