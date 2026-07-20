# CTI Platform

Multi-tenant CTI middleware connecting Asterisk/FreePBX to CRMs — click-to-call, screen pops, automated call logging. Design rationale, event model, and roadmap: [cti-architecture.md](./cti-architecture.md).

**Phase 5 status:** productized. Everything from Phases 1–4 (multi-tenant core, generic webhooks, Zoho PhoneBridge, Salesforce Open CTI softphone) plus: reverse on-prem connector (no inbound firewall holes at the customer), recording proxy with signed URLs, agent presence, and an admin API/dashboard with registry hot-reload.

## Phase 5 additions

- **Reverse connector** — a PBX connection with `mode: reverse` is passive: the customer runs [scripts/connector-agent.mjs](./scripts/connector-agent.mjs) (dependency-free, Node ≥ 21) next to their PBX with `CTI_URL` + `CONNECTOR_TOKEN`; it dials OUT to `wss://cti/connector-ws` and tunnels the local AMI socket. AMI credentials never leave the cloud registry — login happens server-side over the tunnel. Heartbeats (15s ping) reap dead tunnels; the agent owns reconnection with backoff.
- **Recordings** — `MIXMONITOR_FILENAME` is captured into call state; `call.ended` carries `recordingUrl`, a 15-minute signed capability URL served by `GET /v1/recordings/:token` from `RECORDINGS_BASE_DIR` (basename-only tokens, no traversal). Lab: the Asterisk monitor dir is bind-mounted to `../Multi-Tenant-Asterisk-PBX/recordings`. Fetching recordings *through* the reverse tunnel is deferred.
- **Presence** — `agent.state` (`RINGING`/`INUSE`/`NOT_INUSE` derived from call lifecycle, `UNAVAILABLE` from AMI `DeviceStateChange`) broadcast to the tenant's softphone sockets and queryable at `GET /v1/agents/state`.
- **Admin** — `/admin` dashboard (connections, tenants, active calls, queue health) backed by `X-Admin-Key`-guarded endpoints: `GET /admin/overview`, `POST /admin/{pbx-connections,tenants,agents,integrations}` (generated keys/tokens returned exactly once), and `POST /admin/reload` which re-reads the registry and diff-restarts only changed PBX connections.

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
cd ../Multi-Tenant-Asterisk-PBX && docker compose up -d

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

## Notes / deferred

- `synchronize: true` (TypeORM) is dev-only; introduce migrations before any production deployment.
- Call state is in-memory per process; `CoreShowChannels` resync on reconnect and Redis-backed state are follow-ups.
- Registry is loaded at boot — reseed + restart to change tenants (admin CRUD arrives with Phase 5).
