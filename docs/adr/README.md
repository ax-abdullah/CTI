# Architecture Decision Records

Decisions that shaped the CTI platform, in the order they were made. Format: Context → Decision → Consequences. Full background: [cti-architecture.md](../../cti-architecture.md).

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-ami-as-primary-control-surface.md) | AMI (not ARI) as the primary PBX control surface | Accepted |
| [0002](0002-hand-rolled-ami-client.md) | Hand-rolled AMI client instead of npm libraries | Accepted |
| [0003](0003-linkedid-correlation-normalized-events.md) | Linkedid correlation + a normalized event vocabulary | Accepted |
| [0004](0004-multi-tenancy-model.md) | Registry-driven multi-tenancy with shared-PBX routing | Accepted |
| [0005](0005-durable-delivery-bullmq.md) | BullMQ durable queues for all CRM-bound delivery | Accepted |
| [0006](0006-crm-adapter-models.md) | Per-CRM adapter models: Zoho push vs Salesforce softphone vs webhooks | Accepted |
| [0007](0007-reverse-onprem-connector.md) | Reverse on-prem connector over an outbound WebSocket tunnel | Accepted |
| [0008](0008-signed-capability-urls-for-recordings.md) | Signed capability URLs for recordings | Accepted |
