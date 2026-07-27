# Installation Guide

Step-by-step setup of the CTI platform: infrastructure, the application, PBX preparation (lab and production FreePBX), tenant onboarding, and the optional on-prem reverse connector.

## 1. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 21 | global `WebSocket` client is used by scripts; the app itself targets Node 20+ |
| Docker + Compose | any recent | runs PostgreSQL, Redis, and the lab Asterisk |
| An Asterisk/FreePBX to integrate | Asterisk 13+ | FreePBX 15/16/17 all fine |

## 2. Infrastructure (PostgreSQL + Redis)

From the repo root:

```bash
docker compose up -d          # postgres :5433, redis :6380 — loopback only
docker exec cti-postgres pg_isready -U cti   # → accepting connections
```

## 3. Configure the application

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `CREDS_KEY` — master key for credential encryption: `openssl rand -hex 32`
- `SOFTPHONE_JWT_SECRET`, `RECORDINGS_URL_SECRET`, `ADMIN_API_KEY` — `openssl rand -hex 24` each
- `PUBLIC_BASE_URL` — the URL customers/browsers reach this platform on (used in signed recording links)
- `DATABASE_URL` / `REDIS_HOST` / `REDIS_PORT` — match step 2 unless you changed the compose file
- `RECORDINGS_BASE_DIR` — directory where PBX recordings are visible to this host (see §7)

Build, provision the schema (migrations own it — no `synchronize`), and run the tests:

```bash
npm run build
npm run migration:run   # creates/updates the schema on a clean or existing DB
npm test                # 92 unit + integration tests, no live infra needed
```

## 4. Prepare the PBX (AMI)

The CTI observes and controls the PBX via AMI. **Never expose 5038 to the internet.** Either the CTI reaches AMI over a private network (`direct` mode), or the PBX site runs the reverse connector agent (§8) and no inbound access is needed at all.

### 4a. Production FreePBX

Create a dedicated manager user in `/etc/asterisk/manager_custom.conf`:

```ini
[cti]
secret = <openssl rand -hex 16>
deny = 0.0.0.0/0.0.0.0
permit = <CTI-or-agent-IP>/255.255.255.255
read = call,cdr,dialplan,dtmf,agent
write = call,originate,reporting
writetimeout = 5000
```

Then `fwconsole reload`. Grant only these classes — in particular **never `system` on `write`** (it allows remote command execution through AMI).

Two of these are easy to miss, and omitting them breaks a feature silently rather than loudly:

| Class | Where | Without it |
|---|---|---|
| `agent` | `read` | No `QueueCallerJoin` / `QueueCallerLeave` / `QueueCallerAbandon` / `AgentConnect` / `AgentComplete` events reach the CTI, so the queue wallboard (`GET /v1/queues`) stays empty |
| `reporting` | **`write`** | `CoreShowChannels` returns *Permission denied*, so the restart resync ([ADR-0003](./adr/0003-linkedid-correlation-normalized-events.md)) cannot ask the PBX what is live — calls in flight across a restart are never reconciled |

`reporting` on **write** is not a typo. Asterisk authorises *actions* against the user's **write** perms, and *events* against **read** perms — so an action whose documented privilege is `system,reporting,all` needs one of those on the write side. Putting `reporting` (or even `system`) on `read` does not help; verified against Asterisk 20 with the checks below. It grants no write capability of its own.

Verify effective grants and requirements directly on the PBX:

```bash
asterisk -rx "manager show user cti"                    # read perm / write perm
asterisk -rx "manager show command CoreShowChannels"    # → Privilege: system,reporting,all
```

### 4b. Lab Asterisk (this repo's sibling project)

`../Multi-Tenant-Asterisk` already ships `config/manager.conf` with a `cti` user and maps 5038 to host loopback:

```bash
cd ../Multi-Tenant-Asterisk && docker compose up -d
printf 'Action: Login\r\nUsername: cti\r\nSecret: <secret>\r\n\r\n' | nc -w 3 127.0.0.1 5038
# → Response: Success
```

## 5. Seed or onboard tenants

**Lab bootstrap** (creates the lab connection + two tenants, prints API keys once):

```bash
npm run seed                       # direct mode
SEED_PBX_MODE=reverse npm run seed # reverse mode (prints the connector token)
```

**Real onboarding** uses the admin API instead (see Swagger `/docs`, tag *Admin*):

1. `POST /admin/pbx-connections` — register the customer PBX (`mode: reverse` for NAT'd sites; save the one-time `connectorToken`). For advanced telephony, add a second connection with `driver: "ari"` (`host:port` = ARI HTTP, `ariApp` = your Stasis app) — see §13.
2. `POST /admin/tenants` — save the one-time `apiKey`
3. `POST /admin/agents` — one per extension, with `crmRefs` (`{zoho, salesforce, hubspot, dynamics}` user IDs) and optional WebRTC SIP creds
4. `POST /admin/integrations` — any of `zoho` / `salesforce` / `hubspot` / `dynamics` (a tenant may enable several; call logging fans out to each)
5. `POST /admin/reload` — apply without restarting

## 6. Run and verify

```bash
npm start
curl -s http://127.0.0.1:3000/health   # → {"status":"ok","connections":[{...,"connected":true}]}
```

- Swagger UI: `http://127.0.0.1:3000/docs`
- Admin dashboard: `http://127.0.0.1:3000/admin` (enter `ADMIN_API_KEY`)
- Example webhook consumer: `WEBHOOK_SECRET=<tenant secret> npm run webhook-receiver`
- Test click-to-call: `POST /v1/calls/originate` with the tenant API key (see the Postman collection in `docs/postman/`)

## 7. Recordings

Point `RECORDINGS_BASE_DIR` at a directory containing the PBX's MixMonitor output:

- **Direct connections:** the CTI reads a mount/sync of the monitor dir. Lab: the compose bind-mounts it to `../Multi-Tenant-Asterisk/recordings`; production: mount/sync `/var/spool/asterisk/monitor` (NFS, rsync, object storage).
- **Reverse connections:** no mount needed — set `AGENT_RECORDINGS_DIR` on the connector agent (§8) and the CTI pulls each file from the on-prem agent over the tunnel on demand.

`call.ended` events then carry `recordingUrl` — a 15-minute signed link served by the CTI; the PBX filesystem is never exposed.

## 8. On-prem reverse connector (NAT'd customer PBX)

On a host inside the customer network that can reach the PBX's 5038:

```bash
CTI_URL=wss://cti.example.com/connector-ws \
CONNECTOR_TOKEN=<one-time token from step 5> \
AMI_HOST=127.0.0.1 AMI_PORT=5038 \
node connector-agent.mjs
```

Add `AGENT_RECORDINGS_DIR=/var/spool/asterisk/monitor` to let the agent serve call recordings over its file channel — then NAT'd sites need no shared recordings mount (the cloud pulls each file on demand over the same outbound WSS).

The script is a single dependency-free file (`scripts/connector-agent.mjs`) — copy it to the site. It dials out over 443/TLS, reconnects with backoff, and never stores AMI credentials. Example systemd unit:

```ini
[Unit]
Description=CTI reverse connector
After=network-online.target

[Service]
Environment=CTI_URL=wss://cti.example.com/connector-ws
Environment=CONNECTOR_TOKEN=conn-...
ExecStart=/usr/bin/node /opt/cti/connector-agent.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

## 9. CRM setup

All four CRM adapters store non-secret config + encrypted secrets on a `CrmIntegration` row (`POST /admin/integrations`); each mock in `scripts/mock-*.mjs` proves the contract locally.

- **Zoho:** register the PhoneBridge integration (partner flow), set the click-to-call callback to `POST {PUBLIC_BASE_URL}/v1/integrations/zoho/{tenantSlug}/click-to-call` with the integration's `callbackToken`, and store `clientId`/`clientSecret`/`refreshToken`.
- **Salesforce:** create a connected app (refresh-token flow) in the customer org, import `GET /softphone/callcenter-definition.xml` under Setup → Call Center (replace `CTI_BASE_URL`), assign users, and store the connected-app credentials. Logs a completed Call `Task`.
- **HubSpot:** install a HubSpot app (OAuth), store `clientId`/`clientSecret`/`refreshToken`. Logs a Call engagement; screen pop / click-to-call is the client-side Calling Extensions SDK. Map agents via `crmRefs.hubspot`.
- **Dynamics 365:** register an Azure AD app with an application user in Dataverse, store `clientId`/`clientSecret` + `aadTenantId`/`orgUrl`. Logs a phonecall activity; pop/click-to-call is the client-side Channel Integration Framework. Map agents via `crmRefs.dynamics`.
- **Any other CRM:** consume the signed webhooks (`docs/FEATURES.md` §Generic webhooks) — reference receiver in `scripts/webhook-receiver.mjs`.

## 9b. WebRTC softphone (optional — in-browser audio)

Lets agents take audio in the browser instead of a desk phone.

1. **PBX:** enable a PJSIP WebRTC transport (wss + DTLS-SRTP) and per-agent webrtc endpoints — reference config in `../Multi-Tenant-Asterisk/config/webrtc.conf` (needs `res_http_websocket`, HTTP/TLS on 8089, and a DTLS cert).
2. **CTI env:** set `WEBRTC_WSS_URL` (e.g. `wss://pbx.example.com:8089/ws`), `WEBRTC_SIP_DOMAIN`, and optionally `WEBRTC_STUN_URL`.
3. **Agents:** give each agent SIP credentials (`sipUsername`/`sipPassword`) matching its PBX endpoint — seeded in the lab as `webrtc-<ext>`; set via the registry in production.
4. The softphone page ([public/softphone.html](../public/softphone.html)) then offers **Enable browser audio** → it fetches `GET /v1/softphone/webrtc-config`, registers via self-hosted JsSIP, and places/receives calls with real audio. Without this, the softphone falls back to desk-phone click-to-call.

## 10. Container deployment (production-shaped)

A multi-stage `Dockerfile` (non-root runtime, migrations at startup) and a full stack with a TLS-terminating reverse proxy ship in the repo:

```bash
docker compose -f docker-compose.full.yml up -d --build
curl -k https://localhost:8443/health      # HTTPS via Caddy's internal CA
```

The stack is app + Postgres + Redis + [Caddy](../deploy/Caddyfile). Caddy terminates TLS and transparently upgrades WebSockets, so `wss://…/softphone-ws` and `wss://…/connector-ws` work with no app-side TLS. **Production:** replace `localhost` + `tls internal` in the Caddyfile with your domain — Caddy then provisions a Let's Encrypt certificate automatically — and inject secrets (`CREDS_KEY`, `*_SECRET`, `ADMIN_API_KEY`) from a real store (Docker/K8s secrets, Vault, or a cloud KMS) rather than literals. See [ADR-0009](./adr/0009-tls-terminating-reverse-proxy-deployment.md).

**Secrets / KMS.** Credentials at rest are AES-256-GCM-encrypted under `CREDS_KEY` ([CryptoService](../src/tenants/crypto.service.ts)). For stronger isolation, wrap per-tenant data keys with a cloud KMS (the ADR-0004 upgrade path): store a KMS-encrypted data key per tenant and decrypt it via the KMS at use time, so the master key never lives in the process.

## 11. Go-live runbook (real CRM orgs)

The mock servers (`scripts/mock-*.mjs`) prove the contract; going live needs the customer's own accounts:

1. **Zoho PhoneBridge** — apply for PhoneBridge partner access; create a Server-based OAuth client (correct DC: `.com`/`.eu`/`.sa`). Obtain a refresh token, then `POST /admin/integrations` with `type: zoho`, `config` (DC base URLs + `clientId`), and `secrets` (`clientSecret`, `refreshToken`, `callbackToken`). Register the click-to-call callback `POST {PUBLIC_BASE_URL}/v1/integrations/zoho/{tenantSlug}/click-to-call`. Reconcile payload field names in [zoho-client.ts](../src/crm-adapters/zoho/zoho-client.ts) against the partner docs (confined to that file + the mock).
2. **Salesforce Open CTI** — in the customer org create a Connected App (enable the refresh-token flow), import `GET /softphone/callcenter-definition.xml` under Setup → Call Center (replace `CTI_BASE_URL` with your HTTPS URL), assign users, and `POST /admin/integrations` with `type: salesforce` + the connected-app credentials.
3. **HubSpot** — install a HubSpot app with the calling + engagement scopes, complete the OAuth install to obtain a refresh token, and `POST /admin/integrations` with `type: hubspot`. Embed the softphone via the Calling Extensions SDK for pop/click-to-call.
4. **Dynamics 365** — register an Azure AD app + Dataverse application user, and `POST /admin/integrations` with `type: dynamics` (`aadTenantId`, `orgUrl`, `clientId`/`clientSecret`). Configure the Channel Integration Framework panel for pop/click-to-call.
5. Run `POST /admin/reload`, place a test call, and confirm the screen pop, click-to-dial, and logged activity in each live org.

## 13. Advanced telephony (optional — ARI, coaching, queues, IVR)

- **In-call coaching** works on any AMI PBX today: `POST /v1/supervisor/monitor {supervisorExt, agentExt, mode}` (spy/whisper/barge) uses ChanSpy. Needs registered SIP phones for audio.
- **Queue wallboard**: define Asterisk queues; `GET /v1/queues` and the `queue.stats` WebSocket stream then populate.
- **ARI connector + CRM-driven IVR** (PBXs you control): enable Asterisk's HTTP server + ARI (`http.conf`: `enabled=yes`; `ari.conf`: an ARI user), point an inbound dialplan context at `Stasis(<app>)`, then register a `driver:"ari"` PBX connection (`host:port` = ARI HTTP, `username`/`secret` = the ARI user, `ariApp` = `<app>`). Calls entering Stasis emit the normal `call.*` events and get looked-up + routed. `GET /health/ari` shows status. See [ADR-0011](./adr/0011-ari-advanced-telephony.md).

## 14. Running more than one replica (Phase 12a)

Safe from Phase 12a onward, and **only** from Phase 12a onward — on an earlier build two replicas duplicate every CRM write. Full operator guide: [SCALING.md](./SCALING.md).

**Migrations no longer run at app startup.** N replicas booting together would race the same DDL with no advisory lock, so apply them once, ahead of the rollout:

```bash
npm run migrate          # local (reads .env)
node dist/migrate.js     # container / Kubernetes Job (env from the orchestrator)
```

It exits non-zero on failure, so a deploy stops rather than starting replicas against a half-migrated schema.

Nothing else is required to scale out: give every replica the **identical environment** and start more of them. They coordinate through Redis.

**Roles (Phase 12b).** One image; `CTI_ROLE` selects what a process does. `all` (the default) is every role at once and is what compose and development run.

```bash
CTI_ROLE=connector npm start   # owns PBX sockets; the only role that enqueues
CTI_ROLE=api       npm start   # HTTP + agent WebSockets
CTI_ROLE=worker    npm start   # drains the delivery queues
```

Every role listens on `PORT` and answers `/health/live`, `/health/ready` and `/metrics`. Only `api` serves the tenant API and Swagger — a 404 for `/v1/...` on a connector or worker is expected. Set `DB_POOL_MAX` per role: the Postgres pool is per replica, so the cluster total is that value times the replica count.

```bash
# same env, different ports/hosts — they find each other via Redis
POD_ID=cti-1 PORT=3000 npm start
POD_ID=cti-2 PORT=3002 npm start
```

**Prerequisites, both non-negotiable:**

1. **All replicas share one Redis and one PostgreSQL.** A replica pointed at a different Redis is a silently split cluster: its agents get no events from elsewhere, and because it sees no leases it will duplicate CRM writes.
2. **Redis is HA.** It now holds the ownership leases, so it is a correctness dependency rather than a cache. Sentinel or a managed service.

Optional tuning (defaults are sensible — see `.env.example`):

| Variable | Default | Effect |
|---|---|---|
| `POD_ID` | hostname + random suffix | lease identity; the suffix keeps a restarted pod distinct from its predecessor |
| `LEASE_TTL_MS` | `30000` | how long a crashed replica's connections stay orphaned |
| `LEASE_RENEW_MS` | `10000` | renewal cadence; keep well below the TTL or connections flap |
| `CLUSTER_RPC_TIMEOUT_MS` | `15000` | cross-replica command timeout |

Verify it took:

```bash
curl -s -H "X-Admin-Key: $ADMIN_API_KEY" http://127.0.0.1:3000/admin/cluster
```

Exactly one replica should list a given connection under `owned`; the `leases` array shows the same ownership from every replica's point of view. A replica with `owned: []` is normal and healthy.

> **Don't use `GET /health` as a Kubernetes probe.** It reports only the connections *this* replica owns, so a replica holding none reports `degraded` — and it always returns HTTP 200 regardless. Use `/health/ready` (Postgres + Redis, returns 503 on failure) for readiness and `/health/live` for liveness.

## 12. Production checklist

- [x] TLS/WSS terminated by a reverse proxy (Caddy); connector agents dial `wss://`
- [x] Migrations own the schema (`npm run migration:run`); no `synchronize` in the app
- [x] Originate rate-limited per tenant; graceful shutdown on SIGTERM
- [x] Metrics at `/metrics`; probes `/health/live` + `/health/ready`; dead-letter retry in `/admin`
- [ ] Real Zoho/Salesforce orgs instead of the `scripts/mock-*.mjs` servers (§11)
- [ ] Secrets from a manager/KMS; rotate `ADMIN_API_KEY`; `.env` out of git (already ignored)
- [ ] Point Prometheus at `/metrics` and wire Alertmanager to the `failed`/`connection_down` series (or the structured `alert` logs)
- [ ] If running >1 replica: Redis is **HA** (it holds the ownership leases), every replica shares the same Redis + Postgres, and `/health/ready` — not `/health` — is wired to the readiness probe (§14)
