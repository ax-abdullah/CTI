# Feature Catalog

Every feature of the CTI platform, what it does, how it works, and how to use it. API details: Swagger at `/docs`; request examples: `docs/postman/`. Design rationale: `docs/adr/`. Visual map of how these features fit together: [architecture.html](./architecture.html).

## At a glance

| # | Feature | Surface | Since |
|---|---|---|---|
| 1 | [Click-to-call](#1-click-to-call) | `POST /v1/calls/originate`, softphone, Zoho callback | Phase 1 |
| 2 | [Screen pops](#2-screen-pops) | webhooks, Zoho PhoneBridge, Salesforce Open CTI | Phase 1 |
| 3 | [Automated call logging](#3-automated-call-logging) | webhooks, Zoho activity, Salesforce Task | Phase 1 |
| 4 | [Normalized call events](#4-normalized-call-events) | internal vocabulary all surfaces consume | Phase 1 |
| 5 | [Generic signed webhooks](#5-generic-signed-webhooks) | per-tenant HTTP POST | Phase 1 |
| 6 | [Multi-tenancy](#6-multi-tenancy) | registry, shared-PBX routing, scoped API keys | Phase 2 |
| 7 | [Zoho PhoneBridge adapter](#7-zoho-phonebridge-adapter) | server-side push + click-to-call callback | Phase 3 |
| 8 | [Salesforce Open CTI adapter](#8-salesforce-open-cti-adapter) | embedded softphone + Task logging | Phase 4 |
| 9 | [Softphone & agent sessions](#9-softphone--agent-sessions) | `/softphone`, `/softphone-ws`, agent JWTs | Phase 4 |
| 10 | [Reverse on-prem connector](#10-reverse-on-prem-connector) | `/connector-ws` + `connector-agent.mjs` | Phase 5 |
| 11 | [Agent presence](#11-agent-presence) | `agent.state` events, `GET /v1/agents/state` | Phase 5 |
| 12 | [Call recordings](#12-call-recordings) | signed URLs, `GET /v1/recordings/:token` (local or over tunnel) | Phase 5 / 9 |
| 13 | [Admin API & dashboard](#13-admin-api--dashboard) | `/admin`, hot reload, dead-letter retry | Phase 5 / 8 |
| 14 | [Observability & deployment](#14-observability--deployment) | `/metrics`, `/health/live`+`/ready`, JSON logs, Docker + Caddy TLS | Phase 6–9 |
| 15 | [WebRTC softphone](#15-webrtc-softphone-phase-10) | in-browser audio via self-hosted JsSIP | Phase 10 |
| 16 | [HubSpot & Dynamics adapters](#16-hubspot--dynamics-adapters-phase-10) | Call engagement / phonecall activity | Phase 10 |
| 17 | [Advanced telephony (ARI)](#17-advanced-telephony-ari--phase-11) | coaching, queue wallboard, CRM-driven IVR | Phase 11 |
| 18 | [Horizontal scale](#18-horizontal-scale--phase-12a) | run N replicas safely; `GET /admin/cluster` | Phase 12a |
| 19 | [Security model](#19-security-model) | cross-cutting | all |

---

## 1. Click-to-call

Ring the agent's phone first; when they pick up, the PBX dials the customer — no dead air, correct caller ID.

- **How:** AMI `Originate` (`Async: true`) with the tenant's `originateChannelTemplate` (`PJSIP/{ext}` in production) into its `originateContext`. A `CTI_CALL_REF` channel variable ties the resulting events back to the API call.
- **Entry points:** `POST /v1/calls/originate` (tenant API key) · softphone dial pad / Salesforce click-to-dial (`POST /v1/softphone/originate`, agent token) · Zoho dial icon (`POST /v1/integrations/zoho/:slug/click-to-call`, callback token).
- **Returns** `{ callRef }`; the same `callRef` reappears on `call.ended`.

## 2. Screen pops

The agent sees who's calling before they answer.

- **Custom CRM:** react to the `call.ringing` webhook (contains `remoteNumber`, `agentExt`, `direction`).
- **Zoho:** the adapter POSTs a RINGING notify; **Zoho matches the number and renders the pop** for the mapped user.
- **Salesforce:** the embedded softphone receives `call.ringing` over WebSocket and calls `sforce.opencti.searchAndScreenPop` — Salesforce finds and opens the record.

## 3. Automated call logging

Every completed call becomes a CRM activity without agent effort.

- **Trigger:** the `call.ended` event (disposition, `durationSec`, `billsecSec`, `recordingUrl`).
- **Zoho:** ENDED update → Zoho logs the call activity automatically.
- **Salesforce:** durable queue creates a completed Call `Task` (duration, disposition, description) owned by the mapped user.
- **Custom:** consume the webhook and write your own record.

## 4. Normalized call events

The core abstraction ([src/call-state/](../src/call-state/)): raw AMI is channel-centric and noisy; the CallState engine correlates channels by **Linkedid** into calls and emits a small vocabulary — `call.ringing`, `call.answered`, `call.ended` — plus `agent.state`. Everything downstream (webhooks, Zoho, Salesforce, softphone, presence) consumes only this vocabulary; no AMI types leak past the engine. Handles Local-channel noise, direction detection, queue/transfer re-parenting, and finalization grace periods. See ADR-0003.

## 5. Generic signed webhooks

The lowest-common-denominator CRM surface — any system that can receive HTTP can integrate.

- Per-tenant `webhookUrl` + secret; every normalized event is POSTed as `{ id, type, tenantId, occurredAt, data }`.
- **Signature:** `X-CTI-Timestamp` (epoch ms) and `X-CTI-Signature` = hex HMAC-SHA256(secret, `${timestamp}.${body}`). Reject skew > 5 min; compare constant-time. Reference consumer: [scripts/webhook-receiver.mjs](../scripts/webhook-receiver.mjs).
- **Delivery:** durable BullMQ queue, 4 attempts with exponential backoff, failures held for inspection (`/admin/overview`).

## 6. Multi-tenancy

One platform, many customers, hard isolation.

- **Registry (PostgreSQL):** PbxConnection → Tenants → Agents + CrmIntegrations. PBX secrets, webhook secrets, and CRM credentials stored AES-256-GCM encrypted; API keys and connector tokens stored as sha256 hashes, shown exactly once.
- **Shared-PBX routing:** several tenants may share one Asterisk (the lab's tenant-a/tenant-b model); events route to the owning tenant by dialplan context first, then extension pattern.
- **Scoping:** the tenant API key resolves the tenant on every request; events carry `tenantId` end-to-end; CRM delivery looks up per-tenant config at delivery time.

## 7. Zoho PhoneBridge adapter

Server-side push model — no UI to build.

- **Events out:** RINGING notify (creates the call, pops the contact for `Agent.crmRefs.zoho`), ANSWERED/ENDED updates (activity logging), via the durable `zoho-delivery` queue.
- **Auth:** per-org OAuth2 refresh-token flow; access tokens cached and invalidated on 401. DC-aware (`.com`/`.eu`/`.sa`).
- **Click-to-call in:** Zoho calls `POST /v1/integrations/zoho/:tenantSlug/click-to-call` with the per-integration callback token.
- **Lab:** `scripts/mock-zoho.mjs` speaks the same contract. Payload shapes to be reconciled with partner docs once PhoneBridge registration is approved (only `zoho-client.ts` + mock change).

## 8. Salesforce Open CTI adapter

Client-side model — we host the softphone, Salesforce embeds it.

- **Softphone panel:** [public/softphone.html](../public/softphone.html) loaded via a Call Center definition ([public/callcenter-definition.xml](../public/callcenter-definition.xml)); wires `searchAndScreenPop` + `onClickToDial`.
- **Task logging:** `call.ended` → durable `salesforce-delivery` queue → REST `Task` create (connected-app refresh-token flow) owned by `Agent.crmRefs.salesforce`.
- **Lab:** `scripts/mock-salesforce.mjs`.

## 9. Softphone & agent sessions

- `POST /v1/softphone/login {ext}` (tenant API key) → short-lived HS256 agent token (8 h).
- `WS /softphone-ws?token=…` → that agent's `call.*` events + the tenant's `agent.state` events, in real time.
- `POST /v1/softphone/originate` (Bearer agent token) → click-to-dial.
- The page also runs standalone (outside Salesforce) as a lab/agent utility.

## 10. Reverse on-prem connector

Install at any customer **without inbound firewall holes**.

- A `mode: reverse` PBX connection is passive; the customer runs [scripts/connector-agent.mjs](../scripts/connector-agent.mjs) (single dependency-free file) which dials OUT to `wss://cti/connector-ws?token=…` and pipes the local AMI socket through the tunnel.
- AMI login happens **cloud-side** over the tunnel — the agent never holds PBX credentials; it only has a revocable connector token (stored hashed).
- Liveness: 15 s ping heartbeats reap dead tunnels; the agent reconnects with backoff. One tunnel per connection; extras are refused.

## 11. Agent presence

`agent.state` per extension: `RINGING` / `INUSE` / `NOT_INUSE` derived from the call lifecycle (works on any PBX), `UNAVAILABLE` from AMI `DeviceStateChange` (phone unregistered). Broadcast to the tenant's softphone sockets; snapshot at `GET /v1/agents/state`.

## 12. Call recordings

- The engine captures `MIXMONITOR_FILENAME`; `call.ended` carries `recordingUrl` — a **15-minute signed capability URL**.
- `GET /v1/recordings/:token` streams the wav. Tokens embed only the file basename (traversal-proof) plus the originating connectionId, and expire; tampering → 404. The PBX filesystem is never exposed.
- **Source of the bytes:** direct connections read `RECORDINGS_BASE_DIR` (a mount/sync of the monitor dir); **reverse connections pull the file from the on-prem agent over its file channel** (`/connector-files`), so NAT'd customers need no shared recordings mount (Phase 9, ADR-0009).

## 13. Admin API & dashboard

- `/admin` — auto-refreshing dashboard: connection status, tenants, active calls, queue health, **dead letters** with a Retry button.
- `X-Admin-Key` API: `GET /admin/overview`, `POST /admin/{pbx-connections,tenants,agents,integrations}` (generated credentials returned once), `GET /admin/dead-letters` + `POST /admin/dead-letters/:queue/:jobId/retry`, `POST /admin/reload` — hot-reloads the registry and restarts **only changed** PBX connections; live tunnels survive.

## 14. Observability & deployment

Production operability (Phases 6–9):

- **Structured JSON logging** (`LOG_FORMAT=json`) with an HTTP request log (method/path/status/duration/tenant).
- **Prometheus `/metrics`** (`prom-client`): calls by tenant/direction/disposition, event counts, originate latency histogram, per-connection up/down, per-queue depth (all five delivery queues) — plus default Node metrics.
- **Probes:** `/health/live` (process) and `/health/ready` (Postgres + Redis → 200/503), distinct from the human-facing `/health`.
- **Alerting:** structured `alert` WARN logs on connection-down and dead-letter (failed) jobs; retry from the admin UI.
- **Reliability:** call-state persisted to Redis (survives restart; `CoreShowChannels` resync on reconnect), per-tenant originate rate-limit, graceful shutdown.
- **Deployment:** multi-stage `Dockerfile` (non-root, migrations at startup) + `docker-compose.full.yml` (app + Postgres + Redis + **Caddy** TLS/wss reverse proxy). Tests: 60-case Jest suite + GitHub Actions CI. See [INSTALL §10](../docs/INSTALL.md), [ADR-0009](./adr/0009-tls-terminating-reverse-proxy-deployment.md).

## 15. WebRTC softphone (Phase 10)

The agent can take **real audio in the browser tab** instead of a desk phone. `GET /v1/softphone/webrtc-config` (agent token) returns the SIP registration params (`wssUrl`, `sipUri`, `authUser`, `password`, `iceServers`) from the agent's registry SIP credentials; the softphone page registers over `wss` via self-hosted JsSIP. When audio is enabled, Dial places a SIP call and inbound calls ring the tab; otherwise it falls back to the desk-phone originate. Reference Asterisk config: `webrtc.conf` (wss transport + DTLS-SRTP endpoints).

## 16. HubSpot & Dynamics adapters (Phase 10)

Two more CRMs behind the same normalized-event bus, following the Zoho/Salesforce shape:

- **HubSpot** ([src/crm-adapters/hubspot/](../src/crm-adapters/hubspot/)) — `call.ended` → a HubSpot **Call engagement** (durable `hubspot-delivery` queue), owned by `Agent.crmRefs.hubspot`. Pop / click-to-call is the client-side Calling Extensions SDK.
- **Dynamics 365** ([src/crm-adapters/dynamics/](../src/crm-adapters/dynamics/)) — `call.ended` → a Dataverse **phonecall activity** (`dynamics-delivery` queue), owned via `ownerid@odata.bind` from `Agent.crmRefs.dynamics`. Pop / click-to-call is the client-side Channel Integration Framework.

A tenant may enable several CRMs at once; logging fans out to each enabled adapter.

## 17. Advanced telephony (ARI) — Phase 11

Beyond observe + originate, on PBXs you control ([ADR-0011](./adr/0011-ari-advanced-telephony.md)):

- **ARI connector** — a `driver='ari'` PbxConnection is managed alongside AMI ([src/pbx-connector/ari/](../src/pbx-connector/ari/)): a hand-rolled `AriClient` (REST + Stasis WebSocket) and `AriSupervisorService`. Stasis events emit the **same** normalized `call.*` vocabulary, so webhooks/CRMs/metrics work unchanged. `GET /health/ari` shows connection status.
- **In-call coaching** — `POST /v1/supervisor/monitor {supervisorExt, agentExt, mode}` (tenant key): `spy` (listen), `whisper` (talk to the agent only), `barge` (join). Backed by AMI **ChanSpy** (any AMI PBX) or ARI **snoop**.
- **Queue/ACD wallboard** — `GET /v1/queues` (tenant key) and a `queue.stats` stream on the softphone WebSocket: waiting callers, answered/abandoned, avg hold/talk, available members — aggregated from `app_queue` events.
- **CRM-driven IVR** — on an inbound Stasis call, the caller is looked up and `RoutingService` decides priority/queue/prompt and sets channel variables before handing the call back to the dialplan.

## 18. Horizontal scale — Phase 12a

Run more than one replica without duplicating CRM records. Full operator guide: [SCALING.md](./SCALING.md); rationale: [ADR-0012](./adr/0012-single-writer-ownership-for-horizontal-scale.md) and [ADR-0013](./adr/0013-cluster-event-bus-and-exactly-once-enqueue.md).

- **Single-writer ownership** — a PBX connection is driven by exactly one replica, held as a Redis lease (`cti:lease:{ami|files}:{connectionId}`, 30s TTL, renewed every 10s, released on `SIGTERM`). Losing a lease stops that connection at once. `direct` connections are claimed lease-first; `reverse` are **tunnel-first**, since the connection can only be served where the customer's connector agent landed.
- **Cluster event bus** — `call.*`, `agent.*` and `queue.*` are mirrored over Redis pub/sub and re-emitted on every replica, so an agent's screen pop arrives whichever replica holds their WebSocket. Raw `ami.event` deliberately stays local to the owning pod.
- **Exactly-once delivery** — only the replica that *derived* an event enqueues it (mirrored copies carry a marker every dispatcher skips), and `call.ended` additionally takes a `SET NX` claim so a lease handover cannot double-log a call.
- **Cross-pod commands** — click-to-call, coaching, `CoreShowChannels` and recording fetches are routed over Redis request/reply to whichever replica holds the socket. This is what makes click-to-call work on a replica that is not holding a customer's reverse tunnel.
- **Shared state** — call state, agent presence (`GET /v1/agents/state`) and queue stats (`GET /v1/queues`) all live in Redis, so every replica answers identically. Queue counters now also survive a handover instead of resetting to zero.
- **Registry fan-out** — `POST /admin/reload` broadcasts to every replica, so a new tenant or rotated API key takes effect everywhere rather than on the one pod that received the request.
- **`GET /admin/cluster`** (admin key) — which replica owns each connection, with lease expiry. The first thing to check when a connection looks down: usually it is simply owned elsewhere.

> Redis is now a **correctness dependency**, not a cache — the leases live there. Run it HA before production.

## 19. Security model

- AMI users scoped to `read=call,cdr,dialplan,dtmf,agent` / `write=call,originate,reporting`; never `system` on write; 5038 never public. (`agent` on read carries the queue events the wallboard needs; `reporting` on **write** is what the `CoreShowChannels` action — the restart resync — requires, because Asterisk authorises actions against write perms and events against read perms.)
- Secrets at rest: AES-256-GCM under `CREDS_KEY`; keys/tokens hashed (sha256) with one-time disclosure.
- All key comparisons are constant-time. Webhooks signed (HMAC + timestamp). Recordings via expiring capability URLs. Four separate auth realms: tenant API key, agent token, admin key, connector/callback tokens.
