# ADR-0001: AMI as the primary PBX control surface

**Status:** Accepted (Phase 0)

## Context

Asterisk offers three integration surfaces: AMI (TCP event stream + actions), ARI (REST/WebSocket with full call control via Stasis apps), and dialplan-level hooks (AGI/`CURL()`). The product must bolt onto **customers' existing FreePBX servers** with minimal footprint and observe *all* calls, and needs exactly three capabilities: observe call lifecycle, originate calls, read CDR data.

## Decision

Use **AMI** as the primary surface. ARI is deliberately not used.

## Rationale

- FreePBX ships with AMI enabled; integration = one manager user, **zero dialplan changes**.
- AMI sees every call however it was routed; ARI only sees channels explicitly sent to a `Stasis()` app, which would mean editing every customer's dialplan and taking responsibility for their routing.
- Screen pops, click-to-call, and logging never need media/bridge ownership — AMI's `Originate` + event stream cover the entire feature set.

## Consequences

- The connector abstraction keeps the door open for an ARI connector later (in-call coaching, CRM-driven IVR) without touching downstream code.
- We inherit AMI's noise: channel-centric events require a correlation engine (ADR-0003).
- AMI's coarse auth (user + ACL) makes network placement critical (ADR-0007); manager users are scoped to `read=call,cdr,dialplan,dtmf,agent` / `write=call,originate,reporting`, never `system` on write. Two grants are non-obvious but non-optional: `agent` on **read** gates every `app_queue` event (the wallboard), and `reporting` on **write** gates the `CoreShowChannels` action (the resync in ADR-0003) — Asterisk authorises actions against write perms and events against read perms, so putting `reporting` on read has no effect.
- Dialplan hooks remain a documented degraded mode for PBXs where AMI is unobtainable (hosted providers).
