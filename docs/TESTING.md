# Manual Test & Validation Guide

Hands-on scenarios for a human to validate the CTI platform end-to-end against the lab. Each scenario has **Goal → Steps → Expected → ☐ Pass**. The automated suite (`npm test`, 76 cases) covers unit/integration logic; this guide covers the live flows a machine can't fully assert. For orientation before you start, the interactive diagram at [architecture.html](./architecture.html) traces each of these flows through the system.

## Setup (once)

```bash
# infra + lab PBX
cd ../Multi-Tenant-Asterisk && docker compose up -d      # Asterisk (AMI :5038)
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
Lab dialplan: `1000`/`2000` reach each tenant's queue (answered, recorded); `*43` is a plain echo test; tenant-a = `1XXX`, tenant-b = `2XXX`, `bevatel` = `3XXX` (not in the seed). To end a lab call: `docker exec asterisk-pbx asterisk -rx "channel request hangup all"`.

**Check this first — two scenarios below fail silently without it.** Confirm the manager user's grants:

```bash
docker exec asterisk-pbx asterisk -rx "manager show user cti"
# read perm must include `agent`  → G-series wallboard (L2)
# write perm must include `reporting` → G1 resync (CoreShowChannels)
```

Asterisk authorises actions against **write** perms and events against **read** perms, so `reporting` belongs on `write` — on `read` it does nothing. Without them, G1 silently loses in-flight calls and L2 returns an empty list, with no error in either case.

No registered SIP phones? Drive calls from AMI instead of `/v1/calls/originate`, which needs a reachable `PJSIP/<ext>`:

```bash
docker exec asterisk-pbx asterisk -rx \
  "channel originate Local/1000@tenant-a-internal application Wait 30"
```

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
**L2 — Queue wallboard tracks a live call.** Needs `agent` on the manager user's read perms (see Setup) and a queue on the PBX — the lab's `queue-tenant-a` sits on extension `1000`.
Steps: `GET /v1/queues` (tenant key) for a baseline; place a call into the queue (`channel originate Local/1000@tenant-a-internal application Wait 30`); `GET /v1/queues` again while it waits; hang up and query once more.
Expected: `waiting` goes to `1` while queued, then on hangup `waiting` returns to `0` and `abandoned` increments — `{"queue":"queue-tenant-a","waiting":1,…}` → `{…,"waiting":0,"abandoned":1}`. `queue.stats` messages mirror this on the softphone WS. `membersTotal` stays `0` until real endpoints register as members. ☐
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

## M. Multi-replica correctness (Phase 12a)

**These are the scenarios that fail on any pre-Phase-12 build** — where two replicas produce two of every CRM record. Design: [SCALING.md](./SCALING.md).

Setup: two app processes sharing one Redis + Postgres, plus the tenant-a webhook receiver.

```bash
WEBHOOK_SECRET=receiver-a-secret node scripts/webhook-receiver.mjs 4000 &
POD_ID=pod-A npm start &                 # :3000
PORT=3002 POD_ID=pod-B npm start &       # :3002 (3001 collides with the lab API)
```

**M1 — Exactly one replica drives the PBX.** `GET /admin/cluster` on both (admin key).
Expected: the same `leases` array from both; exactly one lists the connection under `owned`, the other shows `owned: []`. Only the owner's log contains `Connected to 127.0.0.1:5038`. ☐

**M2 — One call produces exactly one of everything.** Place a call (`docker exec asterisk-pbx asterisk -rx "channel originate Local/*43@tenant-a-internal application Wait 6"`), hang up, wait ~8s.
Expected: the receiver logs **exactly one** `call.ringing`, one `call.answered`, one `call.ended`. Two of each means the build predates Phase 12a, or the replicas are on different Redis instances. ☐

**M3 — Ownership handover on graceful shutdown.** `SIGTERM` the owning replica.
Expected: within ~5s the peer logs `Supervising lab-asterisk` and `Connected to …:5038`; `GET /admin/cluster` on the survivor now shows it under `owned`. ☐

**M4 — Handover after a hard kill.** `kill -9` the owner instead.
Expected: the connection is orphaned until the lease TTL expires (≤30s by default), then the peer claims it. Slower than M3 by design — nothing released the lease. ☐

**M5 — In-flight call survives a handover.** Start a long call (`… application Wait 90`), confirm `GET /v1/calls` shows it, then `SIGTERM` the owner. After the peer takes over, hang up.
Expected: `call.ended` still fires **once**, with the original `callId` and a duration spanning the handover. ☐

**M6 — Registry reload reaches every replica.** `POST /admin/reload` against **one** replica.
Expected: `{"status":"reload-broadcast"}`, and *both* logs show a fresh `Registry loaded …` line. Before Phase 12a only the receiving pod reloaded, and the others answered 401 for newly created tenants. ☐

**M7 — Presence reads the same everywhere.** Place a call that rings a tenant extension (`… Local/1001@tenant-a-internal …`), then `GET /v1/agents/state` (tenant key) on **both** replicas.
Expected: byte-identical responses, including from the replica that owns nothing and never saw the AMI events. ☐

**M8 — Wallboard reads the same everywhere.** With a call queued (`… Local/1000@tenant-a-internal …`), `GET /v1/queues` on both.
Expected: identical, both showing `waiting: 1`. After hangup, both show `abandoned` incremented. ☐

**M9 — Click-to-call from a non-owning replica.** `POST /v1/calls/originate` against the replica whose `owned` is empty.
Expected: it succeeds — the command is routed over Redis to the replica holding the PBX socket. A failure here means the RPC path is broken, not the PBX. ☐

**M10 — Split-Redis detection (negative).** Point one replica at a different Redis and repeat M2.
Expected: **two** of every event — demonstrating that the guarantee depends on all replicas sharing one Redis. Restore the config afterwards. ☐

## User-flow use-cases (narrative)

**UC1 — Agent handles an inbound call.** Customer calls the DID → rings the agent's extension → CTI emits `call.ringing` → the CRM (or the agent's softphone) pops the matched contact → agent answers (`call.answered`, presence `INUSE`) → on hangup `call.ended` logs the activity + recording link, presence returns to `NOT_INUSE`. *Validate via B1/B2 + D + E.*

**UC2 — Agent click-to-dials from the CRM.** Agent clicks a number in Zoho/Salesforce/HubSpot/Dynamics → the CRM (callback or client SDK) triggers originate → the agent's phone (or browser) rings first, then the customer → the call is logged on hangup. *Validate via D6 (Zoho) / I (WebRTC) / 1.*

**UC3 — Onboard a new customer with a NAT'd PBX.** Ops creates the reverse PBX connection (gets a connector token), tenant, agents, and CRM integration via the admin API; the customer runs the connector agent; a test call confirms events, logging, and (if configured) recordings — all with no inbound firewall holes. *Validate via J1 + F + E2.*

**UC4 — Survive a crash without losing a call.** An instance is killed mid-call; on restart it rehydrates call-state from Redis and reconciles against the PBX, so the terminal `call.ended` (and its CRM log) still fires. *Validate via G1.*

**UC5 — Recover a failed CRM delivery.** A CRM is briefly down → deliveries dead-letter and raise an alert → ops sees them in `/admin`, fixes the CRM, and retries from the UI → the activity lands. *Validate via H2.*

---

## Result log

Record date, build (`git rev-parse --short HEAD`), environment, and any ☐ that failed with notes. Re-run A + the affected section after a fix.
