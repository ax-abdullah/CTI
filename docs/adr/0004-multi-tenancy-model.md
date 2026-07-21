# ADR-0004: Registry-driven multi-tenancy with shared-PBX routing

**Status:** Accepted (Phase 2)

## Context

The platform is sold to many customers. Some own a whole PBX; hosted-PBX operators run **many tenants on one Asterisk**, partitioned by dialplan context and extension range (the lab mirrors this). AMI is box-scoped, not tenant-scoped: one connection sees everyone's events.

## Decision

- **PostgreSQL registry:** `PbxConnection` (1) ← (N) `Tenant` ← (N) `Agent`, plus `CrmIntegration`. Loaded into memory at boot; `POST /admin/reload` re-reads and diff-restarts only changed connections.
- **One supervised AMI connection per PBX**, shared by its tenants; each call is routed to its owning tenant by dialplan **context first, then extension pattern**, falling back to the sole tenant.
- **Secrets:** AES-256-GCM under a master `CREDS_KEY`; API keys/connector tokens stored as sha256, disclosed exactly once at creation.
- Every internal event carries `tenantId` from the routing point onward; all `/v1` handlers are tenant-scoped by the API-key guard attaching the resolved tenant to the request.

## Consequences

- Hosted-PBX operators are first-class: no per-tenant AMI users needed.
- Context lists and extension patterns must be accurate; a mis-scoped pattern could route calls to the wrong tenant — onboarding validation matters, and cross-tenant tests exist in the E2E flow.
- Connection isolation: one misbehaving PBX cannot take down siblings (per-connection supervision with independent backoff).
- Upgrade path for scale or stricter isolation: per-tenant worker processes, KMS-wrapped per-tenant data keys.
