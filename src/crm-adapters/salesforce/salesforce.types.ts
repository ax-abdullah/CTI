import { CallEndedEvent } from '../../call-state/normalized-events';

export const SALESFORCE_QUEUE = 'salesforce-delivery';

/**
 * Only call.ended reaches this queue: live ringing/answered state goes to
 * the softphone over WebSocket (client-side Open CTI does the screen pop);
 * the REST API is used solely for logging the completed call as a Task.
 */
export interface SalesforceJob {
  tenantSlug: string;
  event: CallEndedEvent;
}
