import { CallAnsweredEvent, CallEndedEvent, CallRingingEvent } from '../../call-state/normalized-events';

export const ZOHO_QUEUE = 'zoho-delivery';

export type ZohoJob =
  | { kind: 'ringing'; tenantSlug: string; event: CallRingingEvent }
  | { kind: 'answered'; tenantSlug: string; event: CallAnsweredEvent }
  | { kind: 'ended'; tenantSlug: string; event: CallEndedEvent };
