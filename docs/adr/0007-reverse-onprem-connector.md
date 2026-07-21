# ADR-0007: Reverse on-prem connector over an outbound WebSocket tunnel

**Status:** Accepted (Phase 5)

## Context

Customer FreePBX boxes sit behind NAT/firewalls. Direct AMI (cloud dials 5038) requires inbound holes, static-IP ACLs, or VPNs — all onboarding friction and risk (ADR-0001 notes AMI's coarse auth). Commercial CTIs solve this with an on-prem agent that dials out.

## Decision

- `PbxConnection.mode: 'reverse'`: the cloud side is passive.
- A **single-file, dependency-free agent** (`connector-agent.mjs`, Node ≥ 21) runs at the customer site, authenticates to `wss://cti/connector-ws` with a revocable one-time token (stored hashed), and pipes the local AMI TCP socket over the WebSocket as raw bytes.
- The **AMI login happens cloud-side** through the tunnel using registry credentials — the agent never holds PBX secrets.
- Liveness: gateway pings every 15 s and terminates silent tunnels; explicit socket-level stream teardown (the wrapped Duplex alone proved unreliable at surfacing remote death); one active tunnel per connection, extras refused; the agent owns reconnection with backoff.

## Consequences

- Customer firewall requirements drop to "outbound 443" — the Phase-5 exit criterion.
- The same `AmiClient` runs over both transports (enabled by ADR-0002), so direct and reverse connections share every downstream behavior.
- The tunnel carries AMI credentials in transit at login: TLS (`wss://`) is mandatory in production.
- Recordings do not traverse the tunnel yet (ADR-0008 serves from a mounted/synced directory); a file channel over the same tunnel is the designated extension.
