# ADR-0009: TLS-terminating reverse proxy + containerized deployment

**Status:** Accepted (Phase 9)

## Context

Everything ran plaintext-local. Production needs TLS everywhere (the reverse-connector tunnel carries AMI credentials at login — ADR-0007), a reproducible runtime, and secrets sourced from something other than a committed `.env`. Recordings for NAT'd customers also needed a path that doesn't require a shared filesystem mount.

## Decision

- **Containerize** the app as a multi-stage image (`Dockerfile`): build → prod-deps → slim non-root runtime. Migrations run at startup (`migrationsRun`), so the entrypoint is just `node dist/main.js`; env comes from the orchestrator.
- **Terminate TLS at a reverse proxy** (Caddy in `docker-compose.full.yml` + `deploy/Caddyfile`), never in the app. Caddy transparently upgrades WebSockets, so `wss://…/softphone-ws` and `wss://…/connector-ws` work with no extra config; `flush_interval -1` keeps the long-lived tunnels un-buffered. Local uses Caddy's internal CA; production swaps in a domain and Caddy provisions Let's Encrypt automatically.
- **Recordings over the tunnel:** the reverse connector opens a second WS (`/connector-files`) authenticated by the same connector token; `RecordingsService` embeds the `connectionId` in the signed recording token and, for reverse connections, pulls the file from the agent on demand instead of a local mount. Direct connections still read the mount. Basename-only, TTL-limited — the capability-URL guarantees from ADR-0008 are unchanged.
- **Secrets** stay env-injected but are documented for a real store (Vault/KMS/Docker secrets); the compose interpolates them rather than hard-coding.

## Consequences

- One image runs in any orchestrator (Compose today, Kubernetes/Helm later); the app never sees a private key.
- Customers open only outbound 443 — the AMI tunnel *and* recording fetches ride the same authenticated outbound WSS, so a NAT'd FreePBX needs zero inbound holes and no recordings share. This is the Phase-5 "installable without inbound firewall holes" goal fully realized including media.
- Trade-off: recordings pulled over the tunnel add latency and flow through the cloud process; fine for on-demand playback, not bulk export (documented).
- The real Zoho/Salesforce go-live still requires the customer's partner registration / connected app — an operational step, not a code change (see INSTALL §Go-live).
