# ADR-0002: Hand-rolled AMI client instead of npm libraries

**Status:** Accepted (Phase 1)

## Context

The npm ecosystem's AMI clients (`asterisk-manager`, `asterisk-ami-client`) are mature but unmaintained for years, untyped or weakly typed, and own their socket — which blocks running the protocol over anything but a TCP connection they create.

## Decision

Implement a minimal typed AMI client in-house (`src/pbx-connector/ami-client.ts`, ~150 lines): CRLF key/value frame parsing, ActionID-matched request/response with timeouts, event emission, and a pluggable transport (any Node `Duplex`).

## Rationale

- The wire protocol is trivial; a dependency is not carrying its weight against the supply-chain and maintenance risk of abandoned packages.
- Owning the client made the **transport abstraction** possible, which the Phase-5 reverse connector depends on (the same client runs unchanged over a WebSocket tunnel).

## Consequences

- We maintain the protocol edge cases ourselves (banner handling, partial frames, duplicate keys). Acceptable: the surface is small and covered by every E2E run.
- Transport-level liveness is the owner's job — the reverse-connector gateway adds heartbeats because a wrapped stream does not reliably surface remote death (learned in Phase 5 testing).
- Response routing is also ours to get right, and one case was wrong until 2026-07: `sendEventAction` (the list-action path) registered only an event listener, never a `pending` entry, so the action's own `Response: Error` frame matched nothing in `dispatch()` and was dropped. A refused action therefore surfaced as a 10-second *timeout* instead of the PBX's actual message — which is how a missing `reporting` privilege presented. It now registers a pending entry, fails immediately with the returned `Message`, and re-arms the timer on the `Success` ack (since `dispatch()` clears the original). Regression test: `test/ami-client.integration.spec.ts`.
