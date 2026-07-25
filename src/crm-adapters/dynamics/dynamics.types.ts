import { CallEndedEvent } from '../../call-state/normalized-events';

export const DYNAMICS_QUEUE = 'dynamics-delivery';

/**
 * call.ended → a Dataverse phonecall activity. Screen pop / click-to-call in
 * Dynamics is client-side via the Channel Integration Framework (CIF) panel;
 * the server adapter handles logging.
 */
export interface DynamicsJob {
  tenantSlug: string;
  event: CallEndedEvent;
}
