# ADR-0003: Linkedid correlation + a normalized event vocabulary

**Status:** Accepted (Phase 1)

## Context

A single 2-leg call emits 20+ AMI events across multiple channels; FreePBX adds phantom `Local/` legs for follow-me/queues. CRMs want *calls* with a simple lifecycle, not channels. Every downstream consumer (webhooks, Zoho, Salesforce, softphone, presence) needs the same view.

## Decision

A single correlation engine (`CallStateService`) groups all channels by **Linkedid** (Asterisk's call-scoped id), derives a state machine (ringing → answered → ended), and emits a closed vocabulary — `call.ringing`, `call.answered`, `call.ended` (+ `agent.state`). **No AMI types may leak past this layer.**

Key rules: prefer non-Local channels for party/agent resolution but don't drop Local-only calls; `answered` = first of DialEnd(ANSWER) | BridgeEnter | Newstate Up; `ended` = all legs down, finalized after a 1.5 s grace period; `CTI_CALL_REF`/`MIXMONITOR_FILENAME` VarSets enrich the record; direction pinned to outbound when our own originate marker is seen.

## Consequences

- Adding a CRM adapter never touches PBX logic — adapters are ~200-line consumers of three event types.
- The vocabulary is the public webhook contract, so it changes additively only.
- Known trade-off: events emitted before an enriching VarSet arrives can carry provisional data (e.g. click-to-call `ringing` may say `inbound`); `ended` is always authoritative.
- State is in-memory per process; a restart loses in-flight calls only. `CoreShowChannels` resync is the designated future mitigation.
