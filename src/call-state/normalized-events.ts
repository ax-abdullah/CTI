/**
 * The normalized event vocabulary. Everything downstream of CallStateService
 * (webhook dispatcher, future Zoho/Salesforce adapters) consumes ONLY these —
 * no AMI types may leak past the call-state layer.
 */

export type CallDirection = 'inbound' | 'outbound' | 'internal';

export interface CallRingingEvent {
  callId: string;
  tenantId: string;
  direction: CallDirection;
  agentExt?: string;
  remoteNumber?: string;
  remoteName?: string;
  startedAt: string;
}

export interface CallAnsweredEvent {
  callId: string;
  tenantId: string;
  /**
   * Carried so consumers need no per-call routing state of their own. Any
   * replica can act on this event, including one that never saw the matching
   * `call.ringing` — which is the normal case once a connection has a single
   * owner and events reach other pods over the cluster bus.
   */
  agentExt?: string;
  answeredAt: string;
}

export interface CallEndedEvent {
  callId: string;
  tenantId: string;
  direction: CallDirection;
  agentExt?: string;
  remoteNumber?: string;
  disposition: 'ANSWERED' | 'NO ANSWER' | 'BUSY' | 'FAILED';
  durationSec: number;
  billsecSec: number;
  startedAt: string;
  endedAt: string;
  callRef?: string;
  /** Signed short-lived URL served by the CTI recording proxy. */
  recordingUrl?: string;
}

export const CALL_EVENTS = {
  ringing: 'call.ringing',
  answered: 'call.answered',
  ended: 'call.ended',
} as const;
