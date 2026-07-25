# How to Use — Feature Guide

Task-oriented how-tos for every feature. Setup lives in [INSTALL.md](./INSTALL.md); this assumes the app is running (`npm start`) with the lab seeded (`npm run seed`). Endpoints reference the [Postman collection](./postman/CTI-Platform.postman_collection.json) and Swagger `/docs`.

**Conventions.** `{{baseUrl}}` = `http://127.0.0.1:3000`. Auth headers: `X-API-Key` (tenant), `Authorization: Bearer <agentToken>` (softphone), `X-Admin-Key` (admin), `X-Zoho-Token` (Zoho callback). Get the tenant keys from the `npm run seed` output; the admin key is `ADMIN_API_KEY` in `.env`.

---

## 1. Place a click-to-call (agent-leg-first)

Ring an agent's phone, then dial the customer.

```bash
curl -X POST {{baseUrl}}/v1/calls/originate \
  -H "X-API-Key: $TENANT_A_KEY" -H 'Content-Type: application/json' \
  -d '{"agentExt":"1001","number":"+966501234567"}'
# → { "status":"originating", "callRef":"…", "agentExt":"1001", "number":"…" }
```

- The agent (`agentExt`) must belong to the key's tenant, else 400.
- `callRef` reappears on the resulting `call.*` events so you can correlate.
- Over the per-tenant limit (`ORIGINATE_RATE_LIMIT`, default 30/min) → 429.

## 2. See in-flight calls & agent presence

```bash
curl {{baseUrl}}/v1/calls          -H "X-API-Key: $TENANT_A_KEY"   # live calls (from Redis)
curl {{baseUrl}}/v1/agents/state   -H "X-API-Key: $TENANT_A_KEY"   # RINGING/INUSE/NOT_INUSE/UNAVAILABLE
```

## 3. Receive real-time call events (screen-pop feed)

Connect a WebSocket **as an agent** and you get that agent's `call.ringing` / `call.answered` / `call.ended` plus tenant-wide `agent.state`. Use this to drive a custom screen pop.

```bash
# 1) get an agent token
TOKEN=$(curl -s -X POST {{baseUrl}}/v1/softphone/login \
  -H "X-API-Key: $TENANT_A_KEY" -H 'Content-Type: application/json' \
  -d '{"ext":"1001"}' | jq -r .token)

# 2) open the stream (any WS client; wscat shown)
wscat -c "ws://127.0.0.1:3000/softphone-ws?token=$TOKEN"
# ← {"type":"connected","ext":"1001"}
# ← {"type":"call.ringing","callId":"…","direction":"inbound","remoteNumber":"+9665…"}
# ← {"type":"call.answered",…}  ← {"type":"call.ended","disposition":"ANSWERED","durationSec":42,…}
```

## 4. Consume generic webhooks (any CRM / custom app)

Every normalized event is POSTed to the tenant's `webhookUrl`, signed. Verify and react:

```
POST <your webhookUrl>
X-CTI-Timestamp: 1784589088123
X-CTI-Signature: <hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>

{ "id":"uuid", "type":"call.ended", "tenantId":"tenant-a", "occurredAt":"…", "data":{ … } }
```

Rules for consumers: reject if the timestamp is > 5 min old; recompute the HMAC and compare in constant time. Reference receiver: [scripts/webhook-receiver.mjs](../scripts/webhook-receiver.mjs) (`WEBHOOK_SECRET=<tenant secret> node scripts/webhook-receiver.mjs 4000`).

## 5. Fetch a call recording

`call.ended` carries `recordingUrl` — a signed, 15-minute link. Just GET it (the token is the auth):

```bash
curl -o call.wav "{{baseUrl}}/v1/recordings/<token-from-recordingUrl>"
```

Direct-mode PBXs are read from `RECORDINGS_BASE_DIR`; reverse-mode PBXs are pulled from the on-prem agent over the tunnel (set `AGENT_RECORDINGS_DIR` on the agent). Expired/tampered tokens → 404.

## 6. Embed the Salesforce softphone (Open CTI)

1. In the org: Setup → Call Center → Import → `GET {{baseUrl}}/softphone/callcenter-definition.xml` (replace `CTI_BASE_URL` with your HTTPS URL); assign users.
2. Add a `salesforce` integration (`POST /admin/integrations`, connected-app refresh-token creds), map agents via `crmRefs.salesforce`.
3. The embedded page pops via `searchAndScreenPop`, click-to-dials via `/v1/softphone/originate`, and the backend logs a completed Call `Task` on `call.ended`.

## 7. Wire Zoho PhoneBridge

1. Add a `zoho` integration with `clientId`/`clientSecret`/`refreshToken`/`callbackToken` and DC base URLs.
2. In Zoho, set the click-to-call callback to `POST {{baseUrl}}/v1/integrations/zoho/{tenantSlug}/click-to-call` (header `X-Zoho-Token: <callbackToken>`).
3. Map agents via `crmRefs.zoho`. Ringing → Zoho pops the contact; ended → Zoho logs the activity.

Lab: `node scripts/mock-zoho.mjs 4100` speaks the same contract.

## 8. Log calls to HubSpot / Dynamics 365

Both are server-side call logging (pop + click-to-call are their client-side SDKs):

```bash
# HubSpot
curl -X POST {{baseUrl}}/admin/integrations -H "X-Admin-Key: $ADMIN" -H 'Content-Type: application/json' \
  -d '{"tenantSlug":"acme","type":"hubspot","config":{"accountsBaseUrl":"https://api.hubapi.com","apiBaseUrl":"https://api.hubapi.com","clientId":"…"},"secrets":{"clientSecret":"…","refreshToken":"…"}}'
# Dynamics
curl -X POST {{baseUrl}}/admin/integrations -H "X-Admin-Key: $ADMIN" -H 'Content-Type: application/json' \
  -d '{"tenantSlug":"acme","type":"dynamics","config":{"loginBaseUrl":"https://login.microsoftonline.com","aadTenantId":"…","orgUrl":"https://acme.crm.dynamics.com","apiVersion":"9.2","clientId":"…"},"secrets":{"clientSecret":"…"}}'
curl -X POST {{baseUrl}}/admin/reload -H "X-Admin-Key: $ADMIN"
```

Map agents via `crmRefs.hubspot` / `crmRefs.dynamics`. On `call.ended`, HubSpot gets a Call engagement, Dynamics a phonecall activity. **A tenant can enable several CRMs at once — logging fans out to each.** Lab mocks: `mock-hubspot.mjs 4300`, `mock-dynamics.mjs 4400`.

## 9. Use the WebRTC softphone (browser audio)

Prereq: a WebRTC-configured Asterisk (wss + DTLS — reference `webrtc.conf`), `WEBRTC_*` env, and per-agent SIP creds.

1. Open `{{baseUrl}}/softphone?token=<agentToken>` (get the token from `/v1/softphone/login`).
2. Click **Enable browser audio** — it fetches `GET /v1/softphone/webrtc-config`, registers via self-hosted JsSIP, and shows `audio live`.
3. Dial places a SIP call with browser audio; inbound calls ring the tab. Without WebRTC, Dial falls back to the desk-phone originate.

## 10. Onboard a customer (admin API)

```bash
A="-H X-Admin-Key:$ADMIN -H Content-Type:application/json"
# 1. PBX (reverse = customer dials out; save the one-time connectorToken)
curl -X POST {{baseUrl}}/admin/pbx-connections $A -d '{"name":"acme-pbx","mode":"reverse","host":"127.0.0.1","port":5038,"username":"cti","secret":"…"}'
# 2. tenant (save the one-time apiKey)
curl -X POST {{baseUrl}}/admin/tenants $A -d '{"slug":"acme","name":"Acme","pbxConnectionId":"<id>","extensionPattern":"^1\\d{3}$","contexts":["from-internal"],"originateContext":"from-internal","originateChannelTemplate":"PJSIP/{ext}","webhookUrl":"https://crm.acme.com/cti","webhookSecret":"…"}'
# 3. agents  4. integrations  5. apply
curl -X POST {{baseUrl}}/admin/agents $A -d '{"tenantSlug":"acme","ext":"1001","displayName":"Sara","crmRefs":{"hubspot":"owner-42"}}'
curl -X POST {{baseUrl}}/admin/reload -H "X-Admin-Key: $ADMIN"
```

Generated `connectorToken` / `apiKey` are shown **once** — store them then. `/admin/reload` applies changes without a restart (only changed PBX connections reconnect).

## 11. Install the on-prem reverse connector (NAT'd PBX)

On a host inside the customer network that can reach the PBX's 5038:

```bash
CTI_URL=wss://cti.example.com/connector-ws \
CONNECTOR_TOKEN=<from step 1 above> \
AMI_HOST=127.0.0.1 AMI_PORT=5038 \
AGENT_RECORDINGS_DIR=/var/spool/asterisk/monitor \
node connector-agent.mjs
```

It dials OUT over 443/TLS (no inbound firewall holes), tunnels AMI, and serves recordings on a second channel. `/health` then shows the connection `connected`. Run it under systemd (unit in [INSTALL §8](./INSTALL.md)).

## 11b. Supervise & coach (Phase 11)

**In-call coaching** — listen to, whisper to, or barge an agent's live call:

```bash
curl -X POST {{baseUrl}}/v1/supervisor/monitor \
  -H "X-API-Key: $TENANT_A_KEY" -H 'Content-Type: application/json' \
  -d '{"supervisorExt":"1002","agentExt":"1001","mode":"whisper"}'   # mode: spy | whisper | barge
```

The supervisor's phone rings, then joins the agent's call in the chosen mode (AMI ChanSpy, or ARI snoop on ARI connections). Both extensions must belong to the tenant. Coached audio needs registered SIP phones.

**Queue wallboard** — live ACD stats:

```bash
curl {{baseUrl}}/v1/queues -H "X-API-Key: $TENANT_A_KEY"
# → { "queues": [ { "queue":"support", "waiting":2, "answered":10, "abandoned":1,
#                   "membersAvailable":3, "avgHoldSec":18, "avgTalkSec":95 } ] }
```

For a live wallboard, subscribe to the softphone WebSocket (§3) — `queue.stats` messages stream as queues change. Requires queues configured on the PBX.

**ARI / CRM-driven IVR** — register a `driver:"ari"` PBX connection (admin API, `ariApp` = your Stasis app), point the dialplan's inbound context at `Stasis(<app>)`, and calls entering it are looked up and routed (priority/queue/prompt via channel vars) before continuing in the dialplan. `GET /health/ari` shows ARI connection status.

## 12. Operate & monitor

| Task | How |
|---|---|
| Health at a glance | `GET /health` (PBX), `GET /health/ready` (deps), `/admin` dashboard |
| Metrics | `GET /metrics` → point Prometheus at it (call volume, originate latency, connection up/down, queue depth) |
| Failed CRM deliveries | `GET /admin/dead-letters`; retry one with `POST /admin/dead-letters/:queue/:jobId/retry` or the **Retry** button in `/admin` |
| Alerts | structured `alert` WARN logs on connection-down / dead-letters (or Alertmanager on the `cti_queue_jobs{state="failed"}` / `cti_pbx_connection_up` series) |
| Change tenants/agents/integrations | admin `POST` endpoints + `POST /admin/reload` |
| API reference | Swagger UI at `/docs` |

## Troubleshooting

- **`/health` degraded, `connected:false`** — AMI can't authenticate/reach the PBX. Check the manager user/secret and that the CTI (or the reverse agent) can reach 5038; direct mode needs network reachability.
- **originate → 500** — usually the PBX connection is down (see above) or the `originateChannelTemplate`/`originateContext` don't match the dialplan.
- **Webhook/CRM deliveries failing** — check `/admin/dead-letters`; a 401 means an expired CRM token (the adapter auto-refreshes on retry); a connection error means the endpoint is unreachable.
- **WebRTC stuck at "connecting…"** — the browser reached the config endpoint but can't open the `wss` to the PBX; the PBX needs a WebRTC transport (wss + DTLS on 8089).
- **429 on originate** — the per-tenant/agent rate limit; raise `ORIGINATE_RATE_LIMIT` if legitimate.
