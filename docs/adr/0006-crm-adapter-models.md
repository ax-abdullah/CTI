# ADR-0006: Per-CRM adapter models — Zoho push, Salesforce softphone, generic webhooks

**Status:** Accepted (Phases 1–4)

## Context

CRMs impose opposite integration models. Zoho PhoneBridge is **server-side**: you push call notifications, Zoho renders its own pop and logs activities. Salesforce Open CTI is **client-side**: you host a softphone page that Salesforce embeds, and drive pops via its JS API. Forcing one model onto the other's CRM produces a worse product on both.

## Decision

Embrace each CRM's native model behind the shared normalized-event bus, and ship **generic signed webhooks first** as the CRM-agnostic baseline:

- **Webhooks** (baseline): signed POSTs any system can consume; also the internal reference contract.
- **Zoho**: queue consumer pushes RINGING/ANSWERED/ENDED to PhoneBridge; click-to-call arrives as an authenticated callback. No UI owned by us.
- **Salesforce**: we own the softphone UI (WebSocket-fed), Salesforce owns record search/pop; logging is a queue consumer creating `Task` records.
- Agent identity maps through `Agent.crmRefs.{zoho,salesforce}` — one agent row, N CRM identities.

## Consequences

- Each adapter is small and independently deployable conceptually; a new CRM = one dispatcher + one processor (+ optional UI), consuming the same three events.
- Two auth models coexist (per-org OAuth refresh tokens for server-side calls; per-agent short-lived JWTs for the softphone) — deliberate, as they protect different principals.
- The softphone WebSocket gateway built for Salesforce is CRM-neutral and reused by presence and any future embedded UI.
- Zoho payload shapes remain provisional until partner registration grants access to authoritative docs; the mock servers pin our side of the contract so reconciliation is confined to one client file per CRM.
