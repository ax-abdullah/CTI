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
- State is in-memory per process for speed, **written through to Redis** on every mutation (Phase 7), so a restart loses nothing. The mitigation named here as future work — `CoreShowChannels` resync on reconnect — is built and verified: kill `-9` mid-call, restart, and the log reports `resync … kept 1`; the eventual hangup still emits exactly one `call.ended` carrying the original `callId` and a duration spanning the outage.
- **"Exactly one" is now enforced across replicas, not just within a process (Phase 12).** `finalize()` originally gated on a per-process `endedEmitted` boolean, which says nothing about what a peer is doing — and a lease handover can briefly leave two pods holding the same call, the outgoing owner mid-hangup and the incoming one having hydrated it from Redis. Finalisation now takes a `SET NX` claim key first. That claim is deliberately a *separate* key rather than "did our `DEL` remove the snapshot": persistence is fire-and-forget, so a snapshot that had not landed yet would make `DEL` report 0 and silently swallow a real call log. See [ADR-0012](./0012-single-writer-ownership-for-horizontal-scale.md).
- **Operational prerequisite (silent if missed):** the resync issues the `CoreShowChannels` action, whose privilege is `system,reporting,all`. Asterisk authorises *actions* against a manager user's **`write`** perms, so the user needs `reporting` on `write` — granting it on `read` has no effect. Without it the action is refused and every restart loses its in-flight calls, with nothing failing loudly. See [ADR-0001](./0001-ami-as-primary-control-surface.md) and INSTALL §4a.
