# ADR-0005: BullMQ durable queues for all CRM-bound delivery

**Status:** Accepted (Phase 2)

## Context

CRM endpoints (customer webhooks, Zoho, Salesforce) fail routinely — timeouts, expired tokens, rate limits, maintenance windows. Call events keep flowing regardless. Phase 1's in-process retries lost events on crash and coupled event processing to slow consumers.

## Decision

Every outbound delivery goes through a **Redis-backed BullMQ queue** — one per surface (`webhook-delivery`, `zoho-delivery`, `salesforce-delivery`) — with 4 attempts, exponential backoff, and failed jobs retained for inspection (surfaced as `failed` counts on `/admin/overview`). Dispatchers enqueue only for tenants that actually have the surface configured; processors resolve tenant config at delivery time.

## Consequences

- A CRM outage never blocks event processing or other tenants; events survive an app restart once enqueued.
- Ordering across a call's events is not guaranteed under retry — consumers key on `callId` and treat notifications as idempotent updates (the Zoho/Salesforce payloads are designed accordingly).
- Failed-job retention is the dead-letter store; alerting on it is an ops task (production checklist).
- Redis becomes a hard runtime dependency; acceptable since it also backs future call-state externalization.
