import { CALL_EVENTS } from '../call-state/normalized-events';

export const WEBHOOK_QUEUE = 'webhook-delivery';

export interface WebhookEnvelope {
  id: string;
  type: (typeof CALL_EVENTS)[keyof typeof CALL_EVENTS];
  tenantId: string; // tenant slug
  occurredAt: string;
  data: unknown;
}

export interface WebhookJob {
  envelope: WebhookEnvelope;
}
