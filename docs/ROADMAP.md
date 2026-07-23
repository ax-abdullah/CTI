# Roadmap (Phase 6+)

Phases 0–5 are **complete and merged to `main`** — the platform works end-to-end and is fully documented ([FEATURES.md](./FEATURES.md), [INSTALL.md](./INSTALL.md), [adr/](./adr/README.md), Swagger `/docs`). This roadmap covers what comes next.

The platform is feature-complete but **not yet production-safe**: zero automated tests, `synchronize:true` drives the schema, call-state is in-memory (lost on restart, single-instance only), no TLS/observability/rate-limiting, and both CRM adapters run against mock servers. So the plan is **hardening first (Phases 6–9), then expansion (Phases 10–11)**.

## Overview

| Phase | Track | Scope | Exit criterion |
|---|---|---|---|
| **6 — Test suite & CI + migrations** ✅ | Hardening | Jest/supertest unit + integration tests; TypeORM migrations replacing `synchronize`; GitHub Actions | **Done** — 30 tests green; `migration:run` provisions a clean DB |
| **7 — Reliability & correctness** | Hardening | Call-state in Redis (TTL); `CoreShowChannels` resync on reconnect; rate-limit originate; graceful shutdown | App restart loses no in-flight calls; originate rate-limited per tenant |
| **8 — Observability & operations** | Hardening | Structured logs; Prometheus `/metrics`; readiness/liveness probes; dead-letter alerting + retry UI | Metrics scrapeable; a failed CRM delivery alerts and is retryable from the UI |
| **9 — Secure deployment & real CRM go-live** | Hardening | TLS/`wss`; containerization; KMS secrets; real Zoho/Salesforce orgs; recordings over the tunnel | A real customer FreePBX + real Zoho/SF org over TLS, no inbound holes |
| **10 — WebRTC softphone + more CRMs** | Expansion | In-browser audio (PJSIP WebRTC + SIP.js); HubSpot + Dynamics adapters | Agent places/receives a call in the browser; HubSpot pop + log works |
| **11 — Advanced telephony (ARI)** | Expansion | ARI connector; in-call coaching (whisper/barge/spy); queue/ACD; CRM-driven IVR | A supervisor whispers into a live call; queue stats stream to a wallboard |

---

## Track A — Production Hardening

### Phase 6 — Test suite & CI + migrations ✅ Done

Zero automated tests existed; every phase was verified by hand against the lab PBX, and `synchronize:true` drove the schema. Delivered: a Jest suite (30 tests — correlation engine, crypto, agent tokens, recording URLs, webhook signing, AmiClient over a mock socket), TypeORM migrations owning the schema (`npm run migration:run`), and a GitHub Actions workflow ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) that builds, provisions a clean DB via migrations, and runs the suite on every PR.

- **Unit** (Jest, Nest's default): `CallStateService` correlation driven by recorded AMI event fixtures → assert the normalized `call.*` output ([src/call-state/call-state.service.ts](../src/call-state/call-state.service.ts)); `CryptoService` encrypt/decrypt round-trip ([src/tenants/crypto.service.ts](../src/tenants/crypto.service.ts)); `agent-token.util` and `recordings.service` sign/verify ([src/softphone/agent-token.util.ts](../src/softphone/agent-token.util.ts), [src/recordings/recordings.service.ts](../src/recordings/recordings.service.ts)); webhook HMAC signing.
- **Integration** (supertest): `AmiClient` against a mock AMI socket ([src/pbx-connector/ami-client.ts](../src/pbx-connector/ami-client.ts)); supervisor reconnect/backoff; BullMQ processors on a throwaway Redis; a cross-tenant leakage test (guaranteed by design in [api-key.guard.ts](../src/api/api-key.guard.ts) — assert it).
- **Migrations:** replace `synchronize` with TypeORM migrations generated from the current entities ([src/tenants/entities/](../src/tenants/entities/)); add `migration:generate`/`migration:run` scripts; the lab seed runs migrations first.
- **CI:** GitHub Actions — lint + build + unit on every PR; e2e against a compose-spun Postgres/Redis/Asterisk stack.

**Exit:** green CI on PRs; a fresh database is provisioned by `migration:run` alone.

### Phase 7 — Reliability & correctness

The correlation engine keeps call-state in in-memory `Map`s, so a restart drops in-flight calls and the app can only run as a single instance.

- **Call-state in Redis** with a TTL ([src/call-state/call-state.service.ts](../src/call-state/call-state.service.ts); `ioredis` is already a dependency) — survives restarts and unlocks horizontal scaling.
- **`CoreShowChannels` resync** on every (re)connect to rebuild in-flight calls from the PBX's own view — the mitigation named in [ADR-0003](./adr/0003-linkedid-correlation-normalized-events.md); hook into the reconnect path in [supervised-connection.ts](../src/pbx-connector/supervised-connection.ts).
- **Rate-limit** `/v1/calls/originate` and `/v1/softphone/originate` per tenant via `@nestjs/throttler` — originate makes phones ring, so it's an abuse vector.
- **Graceful shutdown:** drain BullMQ workers and close AMI connections cleanly on SIGTERM.

**Exit:** an app restart mid-call loses no in-flight state; originate is rate-limited per tenant.

### Phase 8 — Observability & operations

Today the only operational surfaces are `/health` and the admin dashboard's queue counts.

- **Structured JSON logging** with `tenantId`/`callId` correlation fields threaded through the event pipeline.
- **Prometheus `/metrics`:** call counts by disposition, event-processing lag, queue depth/failures per surface, connection up/down, originate latency.
- **Probes:** distinct readiness vs liveness endpoints for orchestrators (separate from the human-facing `/health`).
- **Alerting** on dead-letter/`failed` queue counts and connection drops; extend the admin dashboard ([public/admin.html](../public/admin.html)) with a dead-letter inspect + retry view.

**Exit:** metrics are scrapeable; a failed CRM delivery raises an alert and can be retried from the UI.

### Phase 9 — Secure deployment & real CRM go-live

Everything runs plaintext-local against mock CRMs. This phase gets a real customer live.

- **TLS/`wss`** terminated by a reverse proxy (nginx/Traefik/Caddy); the connector agent dials `wss://` (mandatory — the AMI login crosses the tunnel, per [ADR-0007](./adr/0007-reverse-onprem-connector.md)).
- **Containerize** the app (Dockerfile) and ship a full-stack compose / Helm chart.
- **Secrets** via env/Vault/KMS; per-tenant KMS-wrapped data keys (the upgrade path in [ADR-0004](./adr/0004-multi-tenancy-model.md)).
- **Real CRM orgs:** replace [scripts/mock-zoho.mjs](../scripts/mock-zoho.mjs) / [scripts/mock-salesforce.mjs](../scripts/mock-salesforce.mjs) with real Zoho PhoneBridge (partner registration; reconcile the provisional payloads in [zoho-client.ts](../src/crm-adapters/zoho/zoho-client.ts)) and a real Salesforce connected app.
- **Recordings over the tunnel:** a file channel on the reverse connector ([ADR-0008](./adr/0008-signed-capability-urls-for-recordings.md) extension) so NAT'd customers need no separate recordings share.

**Exit:** a real customer FreePBX + real Zoho/Salesforce org running over TLS with no inbound firewall holes.

---

## Track B — Capability Expansion

### Phase 10 — WebRTC softphone + HubSpot/Dynamics

Agents are currently tied to a desk phone (the softphone only controls calls; audio lives on the SIP endpoint).

- **In-browser audio:** enable the PJSIP WebRTC transport (`wss` + DTLS-SRTP) on Asterisk ([Multi-Tenant-Asterisk-PBX/config/pjsip.conf](../../Multi-Tenant-Asterisk-PBX/config/pjsip.conf)), embed SIP.js/JsSIP in the softphone page ([public/softphone.html](../public/softphone.html)), and stand up TURN/STUN — the agent takes real audio in the browser tab.
- **New CRM adapters** following the existing dispatcher/processor/module shape ([src/crm-adapters/zoho/](../src/crm-adapters/zoho/), [src/crm-adapters/salesforce/](../src/crm-adapters/salesforce/)): HubSpot Calling Extensions SDK (embedded dialer, Salesforce-like client-side model) and Microsoft Dynamics 365 Channel Integration Framework. Agent↔CRM-user mapping extends the existing `Agent.crmRefs`.

**Exit:** an agent places and receives a call entirely in the browser; a HubSpot screen pop + call log works.

### Phase 11 — Advanced telephony (ARI connector)

AMI covers observe + originate but not media control. [ADR-0001](./adr/0001-ami-as-primary-control-surface.md) deliberately left room for an ARI connector; this phase adds it for the features that need it.

- **ARI connector** beside AMI — a Stasis app for calls that need media control, emitting the *same* normalized vocabulary so nothing downstream changes. It plugs in behind the connector abstraction alongside the direct/reverse AMI connections.
- **In-call coaching:** whisper / barge / silent monitor (ChanSpy or ARI snoop) triggered from a supervisor view on the admin dashboard.
- **Queue/ACD:** consume real-time queue events (`AgentCalled`/`AgentConnect`), expose queue member control, and stream wallboard data.
- **CRM-data-driven IVR:** look the caller up in the CRM before the agent and route/prompt on the result.

**Exit:** a supervisor whispers into a live call; queue statistics stream to a wallboard.

---

## Suggested sequencing

Do Track A in order — each phase depends on the last (tests before refactoring call-state; observability before a real go-live). Track B phases are independent of each other and can start once Phase 9 is in progress. WebRTC (Phase 10) is the largest single lift due to the Asterisk media-path and TURN/STUN work; scope a spike before committing.
