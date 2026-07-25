# Manual Test & Validation Guide

Hands-on scenarios for a human to validate the CTI platform end-to-end against the lab. Each scenario has **Goal → Steps → Expected → ☐ Pass**. The automated suite (`npm test`, 60 cases) covers unit/integration logic; this guide covers the live flows a machine can't fully assert.

## Setup (once)

```bash
# infra + lab PBX
cd ../Multi-Tenant-Asterisk-PBX && docker compose up -d      # Asterisk (AMI :5038)
cd ../CTI && docker compose up -d                            # Postgres :5433, Redis :6380

# build, seed (PRINTS the tenant API keys + admin key ONCE — copy them), run
npm install && npm run build
npm run seed                                                 # copy tenant-a / tenant-b keys
npm start                                                    # app on :3000

# CRM mocks (each prints what it receives)
node scripts/mock-zoho.mjs 4100 &   node scripts/mock-salesforce.mjs 4200 &
node scripts/mock-hubspot.mjs 4300 & node scripts/mock-dynamics.mjs 4400 &

# webhook receivers (one per tenant)
WEBHOOK_SECRET=receiver-a-secret node scripts/webhook-receiver.mjs 4000 &
WEBHOOK_SECRET=receiver-b-secret node scripts/webhook-receiver.mjs 4001 &
```

Set shell vars for convenience: `KEY_A`, `KEY_B` (from seed), `ADMIN` (from `.env` `ADMIN_API_KEY`).
Lab dialplan: `1000`/`2000` are answered echo tests (good for full call lifecycles); tenant-a = `1XXX`, tenant-b = `2XXX`. To end a lab call: `docker exec asterisk-pbx asterisk -rx "channel request hangup all"`.

---

## A. Smoke tests

| # | Goal | Steps | Expected | Pass |
|---|---|---|---|---|
| A1 | App healthy | `curl localhost:3000/health` | `status:"ok"`, connection `connected:true` | ☐ |
| A2 | Readiness | `curl localhost:3000/health/ready` | `200`, `{postgres:true,redis:true}` | ☐ |
| A3 | Liveness | `curl localhost:3000/health/live` | `200 {status:"live"}` | ☐ |
| A4 | Swagger | open `localhost:3000/docs` | UI lists all endpoints + Authorize | ☐ |
| A5 | Metrics | `curl localhost:3000/metrics \| grep cti_` | `cti_pbx_connection_up …} 1` present | ☐ |

## B. Core calling & events

**B1 — Click-to-call fires the full event lifecycle.**
Steps: with the tenant-a webhook receiver running, `POST /v1/calls/originate {agentExt:"1001",number:"1000"}` (header `X-API-Key: $KEY_A`); after ~3s hang up all channels.
Expected: response `originating` + `callRef`; the receiver logs **call.ringing → call.answered → call.ended** with matching `callId`, and `call.ended` carries the same `callRef`, a `disposition`, `durationSec`, `billsecSec`. ☐

**B2 — Live event stream to an agent.**
Steps: get an agent token (`POST /v1/softphone/login {ext:"1001"}`); `wscat -c "ws://localhost:3000/softphone-ws?token=$TOKEN"`; place a call to 1001's tenant.
Expected: socket receives `connected`, then `call.ringing/answered/ended` and `agent.state` transitions (RINGING→INUSE→NOT_INUSE). ☐

**B3 — Active-calls & presence snapshots.**
Steps: mid-call, `GET /v1/calls` and `GET /v1/agents/state` (tenant key).
Expected: the in-flight call appears with `state:"answered"`; the agent shows `INUSE`, returning to `NOT_INUSE` after hangup. ☐

**B4 — Disposition correctness.**
Steps: originate to a busy/unanswered extension (or cancel quickly).
Expected: `call.ended` disposition is `NO ANSWER` / `BUSY` / `FAILED` (not ANSWERED), `billsecSec:0`. ☐

## C. Multi-tenancy & isolation

**C1 — Tenant scoping on the API.**
Steps: call `POST /v1/calls/originate` for a tenant-a extension (`1001`) using **tenant-b's** key.
Expected: `400` — the agent isn't in tenant-b. ☐

**C2 — Event isolation.**
Steps: run both webhook receivers; place a tenant-a call and a tenant-b call.
Expected: receiver-a (4000) only gets tenant-a events, receiver-b (4001) only tenant-b. No cross-delivery. ☐

**C3 — Invalid key rejected.**
Steps: `POST /v1/calls/originate` with a bogus `X-API-Key`.
Expected: `401 Invalid API key`. ☐

## D. CRM adapters (against mocks)

**D1 — Zoho.** Place a tenant-a call. Expected: `mock-zoho` logs a token then RINGING/ANSWERED/ENDED notifies with the mapped `zohoUserId`. ☐
**D2 — Salesforce.** Place a tenant-b call. Expected: `mock-salesforce` logs a token then a `TASK CREATE` with `OwnerId` = mapped user, correct duration/disposition. ☐
**D3 — HubSpot.** Place a tenant-a call. Expected: `mock-hubspot` logs a token then `CALL CREATE` (hs_call_direction, hs_call_duration ms, disposition). ☐
**D4 — Dynamics.** Place a tenant-b call. Expected: `mock-dynamics` logs a token then `PHONECALL CREATE` (directioncode, actualdurationminutes). ☐
**D5 — Multi-CRM fan-out.** Confirm the tenant-a call reached **both** Zoho and HubSpot (tenant-a has both), tenant-b reached **both** Salesforce and Dynamics. ☐
**D6 — Zoho click-to-call callback.** `POST /v1/integrations/zoho/tenant-a/click-to-call` with `X-Zoho-Token: zoho-callback-token-a` and `{zohoUserId:"zuid-1001",number:"1000"}`. Expected: `originating`; wrong token → 401; unmapped user → 400. ☐

## E. Recordings

**E1 — Signed recording URL (direct).** Ensure the tenant-a echo dialplan records (MixMonitor). Place a call to 1000, let it end. Expected: `call.ended.recordingUrl` present; `GET` it → `200 audio/wav` with bytes; append a char to the token → `404`. ☐
**E2 — Recording over the reverse tunnel.** Seed reverse mode (`SEED_PBX_MODE=reverse npm run seed`), run `connector-agent.mjs` with `AGENT_RECORDINGS_DIR` pointing at a dir holding a test wav the cloud has no local copy of; fetch its signed URL. Expected: `200` with the agent's bytes (pulled over the tunnel); missing file → `404`. ☐

## F. Reverse on-prem connector

**F1 — Passive until agent connects.** Seed reverse mode, start the app (no agent). Expected: `/health` `degraded`, connection `connected:false`. ☐
**F2 — Tunnel brings it up.** Start `connector-agent.mjs` with the connector token. Expected: agent logs "tunnel up" + "file channel up"; `/health` → `ok`. Bad token → the agent's WS closes `4401`. ☐
**F3 — Calls flow over the tunnel.** Originate/hang up a call. Expected: same event lifecycle as direct mode. ☐

## G. Reliability (Phase 7)

**G1 — Restart survives an in-flight call.** Place a call to 1000 (stays up). Confirm `GET /v1/calls` shows it and Redis has a `call:*` key (`docker exec cti-redis redis-cli KEYS 'call:*'`). **Kill -9** the app; confirm the Redis key survives. Restart the app; the log shows `resync … kept N`. Hang up the call. Expected: `call.ended` still fires (webhook received) with the original `callRef`/duration. ☐
**G2 — Rate limit.** Fire `POST /v1/calls/originate` >30 times in a minute (same tenant key). Expected: first 30 pass (or 500 if PBX down), then `429`. A different tenant's key is not throttled. ☐
**G3 — Graceful shutdown.** `kill -TERM` the app PID. Expected: process exits cleanly within a few seconds (no hang). ☐

## H. Observability & dead letters

**H1 — Queue metrics.** `curl /metrics | grep cti_queue_jobs`. Expected: all five queues (webhook, zoho, salesforce, hubspot, dynamics) with state labels. ☐
**H2 — Dead letter + retry.** Stop the tenant-a webhook receiver; place a tenant-a call; wait ~15s for 4 attempts to exhaust. `GET /admin/dead-letters` shows the failed job(s) and a structured `alert kind=dead_letters` WARN appears in the app log. Restart the receiver; `POST /admin/dead-letters/webhook/<jobId>/retry`. Expected: the receiver now gets the delivery and the job leaves the dead-letter list. ☐
**H3 — Dashboard.** Open `/admin`, enter the admin key. Expected: connections, tenants (with integrations), active calls, all five queues, and a **Dead letters** table with **Retry** buttons render. ☐

## I. WebRTC softphone

**I1 — Page + config.** Open `/softphone?token=<agentToken>`. Expected: page loads (JsSIP served from `/vendor/jssip.js`), control WS shows `live`. Click **Enable browser audio** → status leaves `audio off`; `GET /v1/softphone/webrtc-config` returns wssUrl/sipUri/authUser/password/iceServers. ☐
**I2 — Media (needs a WebRTC PBX).** With a wss+DTLS-configured Asterisk, register and place a call. Expected: `audio live`, two-way audio in the tab. *(Skip if the lab PBX has no WebRTC transport — the client wiring is covered by I1.)* ☐

## L. Advanced telephony (Phase 11)

**L1 — Coaching endpoint validates + executes.** `POST /v1/supervisor/monitor {supervisorExt:"1002",agentExt:"1001",mode:"whisper"}` (tenant key). Expected: `{status:"coaching",mode:"whisper",...}` and an `AMI whisper on 1001 by 1002` log line; a non-tenant extension (e.g. `9999`) → 400. *(Audible coaching needs registered SIP phones.)* ☐
**L2 — Queue wallboard endpoint.** `GET /v1/queues` (tenant key). Expected: `{queues:[…]}` — empty until queues exist on the PBX; with a configured queue, waiting/answered/members populate and `queue.stats` messages arrive on the softphone WS. ☐
**L3 — ARI status.** `GET /health/ari`. Expected: `{connections:[…]}` — one entry per `driver:"ari"` connection (empty by default). ☐
**L4 — ARI connector (needs a Stasis PBX).** Register a `driver:"ari"` connection, point an inbound context at `Stasis(<app>)`, place a call. Expected: normal `call.ringing/answered/ended` events (ARI-sourced) and an IVR routing log setting `CTI_QUEUE`/`CTI_PRIORITY`. *(Skip without http.conf/ari.conf + Stasis dialplan.)* ☐

## J. Admin & onboarding

**J1 — Create a tenant end-to-end.** Via admin API: `pbx-connections` → `tenants` → `agents` → `integrations` → `reload`. Expected: each returns one-time credentials where applicable; after reload, the new tenant's key works on `/v1/calls/originate` and appears in `/admin/overview`. ☐
**J2 — Hot reload keeps live tunnels.** With a reverse tunnel up, `POST /admin/reload`. Expected: `reloaded`; `/health` still `connected:true` (unchanged connection not restarted). ☐

## K. Security negative cases

| # | Attempt | Expected |
|---|---|---|
| K1 | `/admin/overview` with wrong `X-Admin-Key` | 401 | ☐ |
| K2 | `/v1/softphone/originate` with a garbage Bearer token | 401 | ☐ |
| K3 | `/softphone-ws?token=garbage` | WS closes `4401` | ☐ |
| K4 | `/connector-ws?token=garbage` | WS closes `4401` | ☐ |
| K5 | recording token with a flipped character | 404 | ☐ |
| K6 | expired recording token (wait >15 min) | 404 | ☐ |

---

## User-flow use-cases (narrative)

**UC1 — Agent handles an inbound call.** Customer calls the DID → rings the agent's extension → CTI emits `call.ringing` → the CRM (or the agent's softphone) pops the matched contact → agent answers (`call.answered`, presence `INUSE`) → on hangup `call.ended` logs the activity + recording link, presence returns to `NOT_INUSE`. *Validate via B1/B2 + D + E.*

**UC2 — Agent click-to-dials from the CRM.** Agent clicks a number in Zoho/Salesforce/HubSpot/Dynamics → the CRM (callback or client SDK) triggers originate → the agent's phone (or browser) rings first, then the customer → the call is logged on hangup. *Validate via D6 (Zoho) / I (WebRTC) / 1.*

**UC3 — Onboard a new customer with a NAT'd PBX.** Ops creates the reverse PBX connection (gets a connector token), tenant, agents, and CRM integration via the admin API; the customer runs the connector agent; a test call confirms events, logging, and (if configured) recordings — all with no inbound firewall holes. *Validate via J1 + F + E2.*

**UC4 — Survive a crash without losing a call.** An instance is killed mid-call; on restart it rehydrates call-state from Redis and reconciles against the PBX, so the terminal `call.ended` (and its CRM log) still fires. *Validate via G1.*

**UC5 — Recover a failed CRM delivery.** A CRM is briefly down → deliveries dead-letter and raise an alert → ops sees them in `/admin`, fixes the CRM, and retries from the UI → the activity lands. *Validate via H2.*

---

## Result log

Record date, build (`git rev-parse --short HEAD`), environment, and any ☐ that failed with notes. Re-run A + the affected section after a fix.
