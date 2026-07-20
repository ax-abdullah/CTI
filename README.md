# CTI Platform

Multi-tenant CTI middleware connecting Asterisk/FreePBX to CRMs — click-to-call, screen pops, automated call logging. Design rationale, event model, and roadmap: [cti-architecture.md](./cti-architecture.md).

**Phase 1 status:** single tenant, AMI connector + call-state correlation + signed generic webhooks + click-to-call REST. Zoho PhoneBridge and Salesforce Open CTI adapters come in Phases 3–4.

## Run against the lab PBX

```bash
# 1. Start the lab Asterisk (AMI enabled on 127.0.0.1:5038)
cd ../Multi-Tenant-Asterisk-PBX && docker compose up -d

# 2. Install + build + run the CTI
npm install && npm run build
cp .env.example .env   # fill in AMI_SECRET etc. (lab .env is pre-filled)
npm start

# 3. In another terminal: an example webhook consumer
WEBHOOK_SECRET=lab-dev-webhook-secret npm run webhook-receiver
```

## API

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness + PBX connection state |
| `POST /v1/calls/originate` `{agentExt, number}` | `X-API-Key` | click-to-call (agent leg rings first) |
| `GET /v1/calls` | `X-API-Key` | in-flight calls snapshot |

```bash
curl -s -X POST http://127.0.0.1:3000/v1/calls/originate \
  -H 'X-API-Key: lab-dev-api-key' -H 'Content-Type: application/json' \
  -d '{"agentExt": "1001", "number": "1000"}'
```

## Webhooks

Every normalized event (`call.ringing`, `call.answered`, `call.ended`) is POSTed to `WEBHOOK_URL` as:

```json
{ "id": "uuid", "type": "call.ended", "tenantId": "lab", "occurredAt": "…", "data": { … } }
```

Headers: `X-CTI-Timestamp` (epoch ms) and `X-CTI-Signature` = hex HMAC-SHA256 of `` `${timestamp}.${rawBody}` `` with `WEBHOOK_SECRET`. Reject skew > 5 min; compare in constant time. Reference consumer: [scripts/webhook-receiver.mjs](./scripts/webhook-receiver.mjs).
