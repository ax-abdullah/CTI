# ADR-0011: ARI connector + advanced telephony (coaching, queues, CRM-driven IVR)

**Status:** Accepted (Phase 11)

## Context

AMI covers observe + originate but not media control. [ADR-0001](0001-ami-as-primary-control-surface.md) deliberately kept AMI as the primary surface and left "the door open in the connector abstraction" for ARI, to be added "later, for advanced features" — in-call coaching, queue/ACD, and CRM-data-driven IVR. Phase 11 adds those without disturbing the well-tested AMI path.

## Decision

- **ARI is additive, not a replacement.** AMI stays the primary event + originate surface for `driver='ami'` connections. A new `driver='ari'` on `PbxConnection` (migration `AriDriver`, plus `ariApp`) selects an ARI connection, managed by a **separate `AriSupervisorService`** parallel to the AMI `PbxSupervisorService`. The AMI code is untouched.
- **Same normalized vocabulary.** The `AriConnection` translates Stasis events (`StasisStart` → `call.ringing`, `ChannelStateChange` Up → `call.answered`, `StasisEnd`/`ChannelDestroyed` → `call.ended`) into the exact `call.*` events every downstream consumer already handles — so webhooks/CRMs/metrics work unchanged for ARI-driven calls. A `driver='ari'` connection is served by one instance, so it is the sole event source for its calls (no AMI double-emit).
- **Hand-rolled `AriClient`** (REST via `fetch` + a `ws` event socket), matching the ADR-0002 stance — no ARI SDK. It carries basic-auth on REST and `api_key=user:pass` on the event socket, and exposes the control primitives Phase 11 needs (answer, playback, `snoop`, `continueInDialplan`, channel vars).
- **In-call coaching** (`spy` / `whisper` / `barge`) has two backends behind one endpoint (`POST /v1/supervisor/monitor`, tenant-scoped): AMI **ChanSpy** via Originate (`q`/`w`/`B` options) for AMI connections — works today on the lab and any AMI PBX — and ARI **snoop** channels when an ARI connection + live channel id are available. The option/direction mapping is pure and unit-tested.
- **Queue/ACD wallboard** is AMI-driven: `QueueStatsService` aggregates `app_queue` events (join/leave/abandon, AgentConnect/Complete, member status) per (connection, queue), exposed at `GET /v1/queues` and streamed as `queue.stats` over the softphone WebSocket (scoped to the connection's tenants).
- **CRM-driven IVR** is the pure `RoutingService.decide(number, contact)` — a lookup (pluggable CRM hook) → a routing decision (priority, queue, prompt, channel vars) that the `AriConnection` applies on `StasisStart` before handing the call back to the dialplan.

## Consequences

- The connector abstraction's promise (ADR-0001) is realized: ARI slotted in without touching AMI, and both produce the same events.
- Coaching works on plain AMI PBXs (no ARI required); ARI unlocks the finer snoop control when present. Queue stats and IVR routing logic are unit-tested (75 tests total).
- **Verification boundary (honest):** the routing decision, coaching option mapping, queue aggregation, and `AriClient` (against a mock ARI REST+WS) are unit/integration-tested; the coaching Originate executes live against the lab. *Real coached audio* needs registered SIP phones, *live queue stats* need queues configured on the PBX, and the *ARI/Stasis path* needs `http.conf`/`ari.conf` enabled with a Stasis dialplan — none of which the lab currently has. These are operator prerequisites, documented in INSTALL, not code gaps.
- ARI credentials ride the same encrypted registry (`secretEnc`) as AMI; the ARI HTTP endpoint must be TLS-fronted or private, same as AMI 5038.
