# Roadmap (Phase 6+)

Phases 0–5 are **complete and merged to `main`** — the platform works end-to-end and is fully documented ([FEATURES.md](./FEATURES.md), [INSTALL.md](./INSTALL.md), [adr/](./adr/README.md), Swagger `/docs`). This roadmap covers what comes next.

The platform is feature-complete but **not yet production-safe**: zero automated tests, `synchronize:true` drives the schema, call-state is in-memory (lost on restart, single-instance only), no TLS/observability/rate-limiting, and both CRM adapters run against mock servers. So the plan is **hardening first (Phases 6–9), then expansion (Phases 10–11)**.

## Overview

| Phase | Track | Scope | Exit criterion |
|---|---|---|---|
| **6 — Test suite & CI + migrations** ✅ | Hardening | Jest/supertest unit + integration tests; TypeORM migrations replacing `synchronize`; GitHub Actions | **Done** — 30 tests green; `migration:run` provisions a clean DB |
| **7 — Reliability & correctness** ✅ | Hardening | Call-state in Redis (TTL); `CoreShowChannels` resync on reconnect; rate-limit originate; graceful shutdown | **Done** — verified live: SIGKILL mid-call → resync recovers → `call.ended` still fires; originate 429 after per-tenant limit |
| **8 — Observability & operations** ✅ | Hardening | Structured logs; Prometheus `/metrics`; readiness/liveness probes; dead-letter alerting + retry UI | **Done** — /metrics scrapeable; a failed delivery alerts (structured WARN) and is retryable from the admin UI |
| **9 — Secure deployment & real CRM go-live** ◑ | Hardening | TLS/`wss`; containerization; KMS secrets; real Zoho/Salesforce orgs; recordings over the tunnel | **Engineering done** (image + TLS proxy + recordings-over-tunnel verified); real Zoho/SF go-live is an operational step needing customer accounts (runbook in INSTALL §11) |
| **10 — WebRTC softphone + more CRMs** ✅ | Expansion | In-browser audio (PJSIP WebRTC + JsSIP); HubSpot + Dynamics adapters | **Done** — HubSpot + Dynamics validated live (call → logged engagement/phonecall, multi-CRM fan-out); softphone loads JsSIP + fetches WebRTC config in-browser. Real two-way audio needs a wss-configured PBX |
| **11 — Advanced telephony (ARI)** ✅ | Expansion | ARI connector; in-call coaching (whisper/barge/spy); queue/ACD; CRM-driven IVR | **Done** — coaching Originate executes live; ARI connector + queue aggregation + IVR routing unit/integration-tested (75 tests). Live coached audio/queues need a Stasis-configured PBX |

---

## Track A — Production Hardening

### Phase 6 — Test suite & CI + migrations ✅ Done

Zero automated tests existed; every phase was verified by hand against the lab PBX, and `synchronize:true` drove the schema. Delivered: a Jest suite (30 tests — correlation engine, crypto, agent tokens, recording URLs, webhook signing, AmiClient over a mock socket), TypeORM migrations owning the schema (`npm run migration:run`), and a GitHub Actions workflow ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) that builds, provisions a clean DB via migrations, and runs the suite on every PR.

- **Unit** (Jest, Nest's default): `CallStateService` correlation driven by recorded AMI event fixtures → assert the normalized `call.*` output ([src/call-state/call-state.service.ts](../src/call-state/call-state.service.ts)); `CryptoService` encrypt/decrypt round-trip ([src/tenants/crypto.service.ts](../src/tenants/crypto.service.ts)); `agent-token.util` and `recordings.service` sign/verify ([src/softphone/agent-token.util.ts](../src/softphone/agent-token.util.ts), [src/recordings/recordings.service.ts](../src/recordings/recordings.service.ts)); webhook HMAC signing.
- **Integration** (supertest): `AmiClient` against a mock AMI socket ([src/pbx-connector/ami-client.ts](../src/pbx-connector/ami-client.ts)); supervisor reconnect/backoff; BullMQ processors on a throwaway Redis; a cross-tenant leakage test (guaranteed by design in [api-key.guard.ts](../src/api/api-key.guard.ts) — assert it).
- **Migrations:** replace `synchronize` with TypeORM migrations generated from the current entities ([src/tenants/entities/](../src/tenants/entities/)); add `migration:generate`/`migration:run` scripts; the lab seed runs migrations first.
- **CI:** GitHub Actions — lint + build + unit on every PR; e2e against a compose-spun Postgres/Redis/Asterisk stack.

**Exit:** green CI on PRs; a fresh database is provisioned by `migration:run` alone.

### Phase 7 — Reliability & correctness ✅ Done

The correlation engine kept call-state in in-memory `Map`s, so a restart dropped in-flight calls and pinned the app to one instance. Delivered:

- **Redis-backed write-through call-state** — a shared `ioredis` client (`RedisModule`); each mutation persists `call:{conn}:{linkedid}` (SET EX 6h, DEL on finalize); `activeCalls()` reads cluster-wide via SCAN, so Redis is the durable source of truth.
- **`CoreShowChannels` resync** on every (re)connect ([resync.service.ts](../src/pbx-connector/resync.service.ts) via the `pbx.connected` event + `AmiClient.sendEventAction`): a pure `reconcile()` finalizes calls the PBX no longer shows, keeps still-live ones, and synthesizes calls started during downtime — ADR-0003's named mitigation.
- **Per-principal rate-limit** on both originate endpoints (`@nestjs/throttler`, Redis storage; `CtiThrottlerGuard` keys by tenant API key / agent token) — configurable via `ORIGINATE_RATE_LIMIT` / `ORIGINATE_RATE_TTL_SEC`.
- **Graceful shutdown** (`enableShutdownHooks`): AMI sockets, BullMQ workers, Redis, and pending finalize timers all close cleanly on SIGTERM.

**Verified live:** a call was SIGKILL'd mid-flight, its state survived in Redis, resync recovered it on restart (`kept 2`), and `call.ended` still fired with the original callRef/duration on hangup; originate returned 429 after the per-tenant limit; SIGTERM exited cleanly in ~2s. 41 tests green.

### Phase 8 — Observability & operations ✅ Done

The only operational surfaces were `/health` and the admin queue counts. Delivered ([src/observability/](../src/observability/)):

- **Structured JSON logging** — a zero-dep `JsonLogger` (one JSON object per line; `LOG_FORMAT=pretty` for local dev) set via `app.useLogger`, plus an HTTP interceptor logging method/path/status/duration/tenant. Event-pipeline logs embed tenant/callId.
- **Prometheus `/metrics`** (`prom-client`): `cti_calls_total{tenant,direction,disposition}`, `cti_call_events_total{type}`, `cti_originate_total` + `cti_originate_duration_seconds` histogram, `cti_pbx_connection_up{connection}` and `cti_queue_jobs{queue,state}` gauges (refreshed on a 5s collector), plus default Node metrics.
- **Probes:** `GET /health/live` (process) and `/health/ready` (Postgres + Redis → 200/503), distinct from the human-facing `/health`.
- **Alerting + dead-letter UI:** the gauge collector emits an edge-triggered structured `alert` WARN on connection-down / failed-queue jobs; `GET /admin/dead-letters` lists failed jobs across queues and `POST /admin/dead-letters/:queue/:jobId/retry` retries one, surfaced as a **Dead letters** panel with Retry buttons in [public/admin.html](../public/admin.html).

**Verified live:** `/metrics` scraped with real call/originate/connection/queue series; `/health/ready` returned 200 with both stores up; a downed webhook endpoint produced 6 dead-letters + an `alert kind=dead_letters` log, and retrying one from the API delivered it to a restored receiver and cleared it. 48 tests green.

### Phase 9 — Secure deployment & real CRM go-live ◑ Engineering done

Everything ran plaintext-local against mock CRMs. Delivered ([ADR-0009](./adr/0009-tls-terminating-reverse-proxy-deployment.md)):

- **Containerized** — multi-stage `Dockerfile` (non-root, migrations at startup) + `docker-compose.full.yml` (app + Postgres + Redis + Caddy).
- **TLS/`wss`** terminated by Caddy ([deploy/Caddyfile](../deploy/Caddyfile)); `wss://…/softphone-ws` and `…/connector-ws` upgrade transparently. Local uses Caddy's internal CA; prod swaps in a domain for automatic Let's Encrypt.
- **Recordings over the tunnel** — the reverse connector's second WS channel ([/connector-files](../src/connector-files/)); `RecordingsService` embeds the connectionId and pulls the file from the on-prem agent for reverse connections, so **NAT'd customers need no recordings share** (closes the ADR-0008 gap).
- **Secrets/KMS** — documented envelope-encryption / KMS path (INSTALL §10); the compose sources secrets from the environment, not literals.

**Verified live:** image builds and boots in-container (readiness 200); HTTPS + WSS work through Caddy; a recording with **no cloud-local copy** was fetched through the tunnel (200, exact bytes) and a missing one 404'd.

**Remaining (operational, needs customer accounts):** real Zoho PhoneBridge (partner registration) and a real Salesforce connected app — step-by-step in [INSTALL §11 Go-live runbook](./INSTALL.md). No code change; the adapters are ready and env-wired.

---

## Track B — Capability Expansion

### Phase 10 — WebRTC softphone + HubSpot/Dynamics ◑ Built & unit-verified

Agents were tied to a desk phone (the softphone only controlled calls; audio lived on the SIP endpoint). Delivered:

- **In-browser audio:** per-agent SIP credentials on the registry (`Agent.sipUsername`/`sipPasswordEnc`, migration `AgentSip`) + `GET /v1/softphone/webrtc-config`; the softphone page ([public/softphone.html](../public/softphone.html)) registers over `wss` via **self-hosted JsSIP** ([public/vendor/jssip.js](../public/vendor/)) and attaches remote audio — Dial then places a SIP call and inbound calls ring the tab. Reference PJSIP WebRTC config in [Multi-Tenant-Asterisk-PBX/config/webrtc.conf](../../Multi-Tenant-Asterisk-PBX/config/webrtc.conf) (wss transport + DTLS-SRTP endpoint template).
- **HubSpot** ([src/crm-adapters/hubspot/](../src/crm-adapters/hubspot/)) and **Dynamics 365** ([src/crm-adapters/dynamics/](../src/crm-adapters/dynamics/)) adapters, following the Zoho/Salesforce dispatcher/processor/module shape: `call.ended` → a HubSpot Call engagement / Dataverse phonecall activity owned by the mapped user (`Agent.crmRefs.hubspot` / `.dynamics`). Screen pop / click-to-call for both is client-side (Calling Extensions SDK / CIF), like Salesforce Open CTI. Mocks: `scripts/mock-hubspot.mjs`, `scripts/mock-dynamics.mjs`.

**Verified (60 tests + live):** HubSpot and Dynamics validated end-to-end against their mocks — a lab call produced a HubSpot Call engagement and a Dataverse phonecall, and since tenant-a runs Zoho+HubSpot and tenant-b Salesforce+Dynamics, this also confirmed **multi-CRM fan-out**. The softphone page loads self-hosted JsSIP (v3.13.8) and fetches valid WebRTC registration params in-browser; all five delivery queues are now surfaced in `/admin/overview`, `/metrics`, and the dead-letter tooling (a gap caught during validation and fixed). The one part still needing your infra: **real two-way browser audio** requires a WebRTC-configured Asterisk (wss transport + DTLS on 8089 — reference `webrtc.conf`); the client wiring is proven, the media path awaits a WebRTC PBX.

### Phase 11 — Advanced telephony (ARI connector) ✅ Done

AMI covers observe + originate but not media control. [ADR-0001](./adr/0001-ami-as-primary-control-surface.md) left room for an ARI connector; this phase adds it and the features that need it ([ADR-0011](./adr/0011-ari-advanced-telephony.md)).

- **ARI connector** beside AMI — hand-rolled `AriClient` (REST + Stasis WS) + `AriSupervisorService` for `driver='ari'` connections. Stasis events translate to the *same* normalized `call.*` vocabulary, so nothing downstream changes. The AMI path is untouched.
- **In-call coaching** — `POST /v1/supervisor/monitor` (spy / whisper / barge) via AMI **ChanSpy** (works on any AMI PBX; executes live in the lab) or ARI **snoop**.
- **Queue/ACD** — `QueueStatsService` aggregates `app_queue` events; `GET /v1/queues` + `queue.stats` streamed over the softphone WebSocket to a wallboard.
- **CRM-driven IVR** — `RoutingService.decide(number, contact)` turns a caller lookup into a routing decision (priority/queue/prompt/vars) the Stasis connector applies before continuing in the dialplan.

**Verified:** coaching Originate executes live against the lab; ARI client (mock REST+WS), routing, coaching mapping, and queue aggregation are unit/integration-tested (75 tests). **Operator prerequisites for full live use:** registered SIP phones for coached audio, queues configured for live wallboard stats, and `http.conf`/`ari.conf` + a Stasis dialplan for the ARI path.

---

**All roadmap phases (0–11) are complete.**

---

## Suggested sequencing

Do Track A in order — each phase depends on the last (tests before refactoring call-state; observability before a real go-live). Track B phases are independent of each other and can start once Phase 9 is in progress. WebRTC (Phase 10) is the largest single lift due to the Asterisk media-path and TURN/STUN work; scope a spike before committing.
