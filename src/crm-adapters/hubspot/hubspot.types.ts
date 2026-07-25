import { CallEndedEvent } from '../../call-state/normalized-events';

export const HUBSPOT_QUEUE = 'hubspot-delivery';

/**
 * Only call.ended reaches this queue: HubSpot's screen pop and click-to-call
 * are client-side (Calling Extensions SDK in the softphone iframe, like
 * Salesforce Open CTI); the server adapter logs the completed call as a
 * HubSpot Call engagement.
 */
export interface HubSpotJob {
  tenantSlug: string;
  event: CallEndedEvent;
}
