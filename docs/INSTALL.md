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
npm test                # 30 unit + integration tests, no live infra needed
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
read = call,cdr,dialplan,dtmf
write = call,originate
writetimeout = 5000
```

Then `fwconsole reload`. Grant only these classes — in particular **never `write = system`** (it allows remote command execution through AMI).

### 4b. Lab Asterisk (this repo's sibling project)

`../Multi-Tenant-Asterisk-PBX` already ships `config/manager.conf` with a `cti` user and maps 5038 to host loopback:

```bash
cd ../Multi-Tenant-Asterisk-PBX && docker compose up -d
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

1. `POST /admin/pbx-connections` — register the customer PBX (`mode: reverse` for NAT'd sites; save the one-time `connectorToken`)
2. `POST /admin/tenants` — save the one-time `apiKey`
3. `POST /admin/agents` — one per extension, with `crmRefs` for Zoho/Salesforce user mapping
4. `POST /admin/integrations` — Zoho and/or Salesforce credentials
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

- **Lab:** the compose file bind-mounts the monitor dir to `../Multi-Tenant-Asterisk-PBX/recordings`.
- **Production:** mount/sync `/var/spool/asterisk/monitor` from the PBX (NFS, rsync, object storage). Fetching recordings *through* the reverse tunnel is on the roadmap.

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

- **Zoho:** register the PhoneBridge integration (partner flow), set the click-to-call callback to `POST {PUBLIC_BASE_URL}/v1/integrations/zoho/{tenantSlug}/click-to-call` with the integration's `callbackToken`, and store `clientId`/`clientSecret`/`refreshToken` via `POST /admin/integrations`.
- **Salesforce:** create a connected app (refresh-token flow) in the customer org, import `GET /softphone/callcenter-definition.xml` under Setup → Call Center (replace `CTI_BASE_URL`), assign users, and store the connected-app credentials via `POST /admin/integrations`.
- **Any other CRM:** consume the signed webhooks (`docs/FEATURES.md` §Generic webhooks) — reference receiver in `scripts/webhook-receiver.mjs`.

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
3. Run `POST /admin/reload`, place a test call, and confirm the screen pop, click-to-dial, and logged activity in the live org.

## 12. Production checklist

- [x] TLS/WSS terminated by a reverse proxy (Caddy); connector agents dial `wss://`
- [x] Migrations own the schema (`npm run migration:run`); no `synchronize` in the app
- [x] Originate rate-limited per tenant; graceful shutdown on SIGTERM
- [x] Metrics at `/metrics`; probes `/health/live` + `/health/ready`; dead-letter retry in `/admin`
- [ ] Real Zoho/Salesforce orgs instead of the `scripts/mock-*.mjs` servers (§11)
- [ ] Secrets from a manager/KMS; rotate `ADMIN_API_KEY`; `.env` out of git (already ignored)
- [ ] Point Prometheus at `/metrics` and wire Alertmanager to the `failed`/`connection_down` series (or the structured `alert` logs)
