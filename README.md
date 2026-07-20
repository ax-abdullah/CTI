# CTI Platform

Multi-tenant CTI middleware connecting Asterisk/FreePBX to CRMs — click-to-call, screen pops, automated call logging. Design rationale, event model, and roadmap: [cti-architecture.md](./cti-architecture.md).

**Phase 2 status:** multi-tenant. Tenant registry in PostgreSQL (AES-256-GCM-encrypted PBX/webhook secrets), one supervised AMI connection per PBX shared by N tenants (routed by dialplan context + extension range), durable per-tenant webhook delivery via BullMQ/Redis, tenant-scoped API keys. Zoho PhoneBridge and Salesforce Open CTI adapters come in Phases 3–4.

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
