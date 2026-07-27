# CTI Platform

Multi-tenant CTI middleware connecting Asterisk/FreePBX to CRMs — click-to-call, screen pops, automated call logging. Design rationale, event model, and roadmap: [cti-architecture.md](./cti-architecture.md). For the whole system at a glance, open the interactive diagram: [docs/architecture.html](./docs/architecture.html).

## Documentation

| Doc | What's in it |
|---|---|
| [docs/architecture.html](./docs/architecture.html) | **Interactive architecture diagram** — 29 components across 7 zones; click any one for what it does and where it lives, trace 7 call flows step by step, or filter by build phase. Open the file directly in a browser (self-contained, no server) |
| [docs/INSTALL.md](./docs/INSTALL.md) | Step-by-step installation: infra, env, PBX prep (lab + production FreePBX), onboarding, WebRTC, reverse connector, container deploy, go-live runbook |
| [docs/HOW-TO-USE.md](./docs/HOW-TO-USE.md) | Task-oriented how-tos for every feature (curl/WS examples) + troubleshooting |
| [docs/TESTING.md](./docs/TESTING.md) | Manual test & validation scenarios, negative cases, and end-to-end user-flow use-cases |
| [docs/FEATURES.md](./docs/FEATURES.md) | Feature catalog — how each works and its endpoints |
| **`/docs` (Swagger UI)** | Live, interactive API reference with all four auth schemes — served by the running app |
| [docs/postman/](./docs/postman/CTI-Platform.postman_collection.json) | Postman collection: every endpoint with request + example responses |
| [docs/SCALING.md](./docs/SCALING.md) | **Running more than one replica** — the ownership invariant, what's shared in Redis, handover/failover behaviour, and a troubleshooting flowchart |
| [docs/adr/](./docs/adr/README.md) | Architecture Decision Records 0001–0013 (AMI-over-ARI, correlation engine, multi-tenancy, reverse connector, deployment, WebRTC/CRM expansion, ARI + advanced telephony, single-writer ownership, cluster event bus) |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Roadmap with per-phase status — phases 0–11 complete, 12a done, 12b/12c remaining |
| [cti-architecture.md](./cti-architecture.md) | Architecture explainer + sequence diagrams (with an as-built note) |

## Status

Built and validated through **Phase 12a**. What's implemented:

- **Core (P1–2):** hand-rolled AMI connector, Linkedid call-state correlation → normalized `call.*` events, multi-tenant registry (shared-PBX routing, encrypted creds, scoped API keys), generic signed webhooks over durable BullMQ.
- **CRMs (P3–4, P10):** Zoho PhoneBridge, Salesforce Open CTI, HubSpot, Microsoft Dynamics 365 — a tenant can enable several; logging fans out to each.
- **Productization (P5):** reverse on-prem connector (no inbound firewall holes), recording proxy with signed URLs, agent presence, admin API + dashboard with hot-reload.
- **Hardening (P6–9):** 76-test Jest suite + CI, TypeORM migrations, Redis-backed call-state + `CoreShowChannels` resync, per-tenant originate rate-limit, graceful shutdown, structured JSON logs, Prometheus `/metrics`, readiness/liveness probes, dead-letter alerting + retry UI, multi-stage Docker image + Caddy TLS/wss reverse proxy, recordings pulled over the reverse tunnel.
- **WebRTC softphone (P10):** in-browser audio via self-hosted JsSIP (real two-way audio needs a WebRTC-configured PBX).
- **Advanced telephony (P11):** ARI connector (Stasis → same normalized events), in-call coaching (spy/whisper/barge), queue/ACD wallboard, CRM-driven IVR routing.
- **Horizontal scale (P12a):** safe to run **more than one replica**. A PBX connection is driven by exactly one replica (Redis lease), events reach every replica over a cluster bus so agent sockets stay live, commands route to whichever replica holds a PBX socket, and presence/queue-stats/call-state are all shared. See [docs/SCALING.md](./docs/SCALING.md).

**Truly pending (operational, not code):** real Zoho/Salesforce/HubSpot/Dynamics org credentials (see [INSTALL §11](./docs/INSTALL.md)); a WebRTC-enabled Asterisk for live browser media; registered SIP phones for audible coaching; and `http.conf`/`ari.conf` + a Stasis dialplan to exercise the ARI driver live. The **queue wallboard is verified live** (it runs on AMI `app_queue` events, not ARI).

> **PBX prerequisite worth knowing before you deploy:** the manager user needs `agent` on `read` (queue events) and `reporting` on **`write`** (the `CoreShowChannels` action behind restart resync). Asterisk authorises actions against `write` perms and events against `read` perms, so `reporting` on `read` does nothing. Omit either and the feature fails silently — full explanation in [INSTALL §4a](./docs/INSTALL.md).

> **Running replicas:** safe from Phase 12a onward, and **only** from Phase 12a onward. On any earlier build two replicas duplicate every CRM write. Redis is now a correctness dependency (it holds the ownership leases), so run it HA before production — see [docs/SCALING.md](./docs/SCALING.md).

## Selected internals

- **Reverse connector** — a PBX connection with `mode: reverse` is passive: the customer runs [scripts/connector-agent.mjs](./scripts/connector-agent.mjs) (dependency-free, Node ≥ 21) with `CTI_URL` + `CONNECTOR_TOKEN`; it dials OUT to `wss://cti/connector-ws` and tunnels the local AMI socket (and, on a second channel, serves recording files). AMI credentials never leave the cloud registry — login happens server-side over the tunnel. Heartbeats (15s ping) reap dead tunnels.
- **Recordings** — `call.ended` carries `recordingUrl`, a 15-minute signed capability URL served by `GET /v1/recordings/:token` (basename-only, traversal-proof). Direct connections read `RECORDINGS_BASE_DIR`; reverse connections pull the file from the on-prem agent over the tunnel — no shared mount needed.
- **Presence** — `agent.state` (`RINGING`/`INUSE`/`NOT_INUSE` from call lifecycle, `UNAVAILABLE` from AMI `DeviceStateChange`) broadcast to the tenant's softphone sockets and queryable at `GET /v1/agents/state`.
- **Admin** — `/admin` dashboard (connections, tenants, active calls, queue health, dead-letter retry) over `X-Admin-Key` endpoints: `GET /admin/overview`, `POST /admin/{pbx-connections,tenants,agents,integrations}` (generated keys/tokens returned once), `POST /admin/dead-letters/:queue/:jobId/retry`, and `POST /admin/reload` (diff-restarts only changed connections).

## Salesforce Open CTI adapter

Salesforce is client-side: we host the softphone page ([public/softphone.html](./public/softphone.html)), Salesforce embeds it via the Call Center definition ([public/callcenter-definition.xml](./public/callcenter-definition.xml), served at `/softphone/callcenter-definition.xml`).

- **Agent session:** `POST /v1/softphone/login {ext}` (tenant API key) returns a short-lived HS256 token (`SOFTPHONE_JWT_SECRET`).
- **Live events:** the page connects to `ws(s)://host/softphone-ws?token=…`; the gateway pushes only that agent's `call.*` events. On inbound ringing the page calls `sforce.opencti.searchAndScreenPop` (when embedded) — Salesforce matches the number and pops the record.
- **Click-to-dial:** Open CTI's `onClickToDial` (or the page's dial pad) POSTs `/v1/softphone/originate` with the agent token → agent-leg-first originate.
- **Call logging:** `call.ended` for Salesforce-enabled tenants flows through the durable `salesforce-delivery` queue; the processor exchanges the org's connected-app refresh token for an access token and creates a `Task` (TaskSubtype Call, duration, disposition) owned by the mapped user (`Agent.crmRefs.salesforce`).
- **Lab testing:** `node scripts/mock-salesforce.mjs 4200` mimics the OAuth + Task endpoints; the seed points tenant-b at it. In production, import the Call Center XML (Setup → Call Center), replace `CTI_BASE_URL`, and assign users.

## Zoho PhoneBridge adapter

Per-tenant `CrmIntegration` rows (type `zoho`) hold the DC/base URLs/client id in `config` and the client secret, refresh token, and callback token encrypted in `secretsEnc`. Flow:

- **Events out:** normalized `call.*` events for Zoho-enabled tenants are mirrored into a durable `zoho-delivery` queue; the processor exchanges the tenant's refresh token for a cached access token and POSTs RINGING (creates the call → Zoho pops the matched contact for the mapped user) then PUTs ANSWERED/ENDED (Zoho logs the activity). Agent ↔ Zoho user mapping lives in `Agent.crmRefs.zoho`.
- **Click-to-call in:** Zoho's dial-icon callback POSTs to `/v1/integrations/zoho/:tenantSlug/click-to-call` (`X-Zoho-Token` = per-integration callback token); the Zoho user resolves to an agent extension and a normal agent-leg-first originate follows.
- **Lab testing:** `node scripts/mock-zoho.mjs 4100` mimics the token + PhoneBridge endpoints; the seed points tenant-a at it. ⚠️ Endpoint paths/payloads follow PhoneBridge v3 shape but must be reconciled with Zoho's partner docs once registration is approved — changes are confined to `zoho-client.ts` + the mock.

## Run against the lab PBX

```bash
# 1. Lab Asterisk (AMI on 127.0.0.1:5038)
cd ../Multi-Tenant-Asterisk && docker compose up -d

# 2. CTI infra (Postgres :5433, Redis :6380)
docker compose up -d

# 3. Build, seed two lab tenants (prints their API keys ONCE), run
npm install && npm run build
npm run seed
npm start

# 4. Example per-tenant webhook consumers
WEBHOOK_SECRET=receiver-a-secret node scripts/webhook-receiver.mjs 4000
WEBHOOK_SECRET=receiver-b-secret node scripts/webhook-receiver.mjs 4001
```

The seed creates `tenant-a` (extensions `1XXX`, contexts `tenant-a-*`) and `tenant-b` (`2XXX`, `tenant-b-*`) sharing the single lab Asterisk — the same shape as a hosted multi-tenant PBX. A production FreePBX is one more `PbxConnection` row with `originateChannelTemplate = PJSIP/{ext}`.

## API

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | per-PBX-connection status |
| `POST /v1/calls/originate` `{agentExt, number}` | `X-API-Key` (tenant) | click-to-call; agent must belong to the key's tenant |
| `GET /v1/calls` | `X-API-Key` (tenant) | in-flight calls of that tenant |

```bash
curl -s -X POST http://127.0.0.1:3000/v1/calls/originate \
  -H "X-API-Key: $TENANT_A_KEY" -H 'Content-Type: application/json' \
  -d '{"agentExt": "1001", "number": "1000"}'
```

## Webhooks

Normalized events (`call.ringing`, `call.answered`, `call.ended`) are enqueued in BullMQ (4 attempts, exponential backoff; failed jobs remain in Redis as dead letters) and POSTed to each tenant's `webhookUrl`:

```json
{ "id": "uuid", "type": "call.ended", "tenantId": "tenant-a", "occurredAt": "…", "data": { … } }
```

Headers: `X-CTI-Timestamp` (epoch ms) and `X-CTI-Signature` = hex HMAC-SHA256 of `` `${timestamp}.${rawBody}` `` with the tenant's webhook secret. Reject skew > 5 min; compare in constant time. Reference consumer: [scripts/webhook-receiver.mjs](./scripts/webhook-receiver.mjs).

## Tests & container deployment

```bash
npm test                                        # 76 unit + integration tests, no live infra
docker compose -f docker-compose.full.yml up -d --build   # app + pg + redis + Caddy (TLS)
curl -k https://localhost:8443/health                     # HTTPS via Caddy
```

Observability: `GET /metrics` (Prometheus), `GET /health/live` + `/health/ready` (probes), structured JSON logs (`LOG_FORMAT=json`). See [INSTALL §10–12](./docs/INSTALL.md) for production deployment, secrets/KMS, and the go-live checklist.

> Earlier "deferred" items (TypeORM migrations, Redis-backed call state + resync, admin CRUD/hot-reload, recordings over the tunnel) are all **implemented** — see the [Status](#status) section. Registry changes now apply via `POST /admin/reload` (no restart).
