# ADR-0010: WebRTC softphone (self-hosted JsSIP) + HubSpot/Dynamics adapters

**Status:** Accepted (Phase 10)

## Context

Two expansion goals: let an agent take **real audio in the browser** (not just control a desk phone), and add **HubSpot** and **Microsoft Dynamics 365** to the CRM roster. Both had to fit the platform's existing seams — the normalized `call.*` event bus, the tenant registry, the softphone page, and the durable-delivery queue pattern — without a heavy frontend build step or new runtime coupling.

## Decision

### WebRTC softphone
- **The browser becomes a SIP endpoint** via WebRTC, registering directly to Asterisk's `wss` transport; the CTI does not proxy media. Call *control* still flows over the existing `/softphone-ws` gateway and REST — WebRTC only adds the audio leg.
- **JsSIP over SIP.js, vendored (self-hosted), not a CDN.** JsSIP ships a stable UMD-able CommonJS entry; we `browserify` it once into [public/vendor/jssip.js](../../public/vendor/) and serve it from our own origin. No external CDN (CSP/security), no frontend bundler in the app.
- **Per-agent SIP credentials live in the registry** (`Agent.sipUsername`/`sipPasswordEnc`, migration `AgentSip`), AES-256-GCM encrypted like every other secret. `GET /v1/softphone/webrtc-config` (agent-token auth) returns the registration params — `wssUrl`, `sipUri`, `authUser`, `password`, `iceServers`.
- **The SIP password is returned to the browser.** WebRTC user-agents perform SIP digest auth client-side, so this is unavoidable and standard; it is scoped to one endpoint and protected by the short-lived agent token over HTTPS.
- **Dual dialing mode:** with audio enabled, Dial places a SIP call and inbound rings the tab; otherwise it falls back to the desk-phone AMI originate. One page serves both worlds.
- WebRTC PBX config (wss transport + DTLS-SRTP endpoints) is delivered as reference [webrtc.conf](../../../Multi-Tenant-Asterisk/config/webrtc.conf), not auto-applied — enabling it is the operator's choice.

### HubSpot & Dynamics adapters
- Both reuse the **Zoho/Salesforce adapter shape** unchanged — a `CrmType`, a token service (refresh/client-credentials → cached access token, invalidated on 401), a thin REST client, and a dispatcher/processor pair over a dedicated durable BullMQ queue. `call.ended` → a HubSpot **Call engagement** / a Dataverse **phonecall activity**, owned by the mapped user (`Agent.crmRefs.hubspot` / `.dynamics`).
- **Screen pop and click-to-call stay client-side** for both (HubSpot Calling Extensions SDK, Dynamics CIF) — the same Open-CTI-style model as Salesforce (ADR-0006), so the server adapter is purely logging.
- A tenant may enable several CRMs at once; logging **fans out** to every enabled adapter independently.

## Consequences

- Agents can work fully in-browser; the desk-phone path remains for sites without WebRTC. Real two-way audio requires a WebRTC-configured Asterisk (wss + DTLS) — the client wiring is proven, the media path is an operator prerequisite.
- Adding a CRM is now demonstrably mechanical: HubSpot and Dynamics landed as ~6 small files each, verified by processor→client→HTTP unit tests plus live mock E2E.
- **New surfaces must be wired into observability explicitly.** The new delivery queues were initially invisible to `/admin/overview`, `/metrics`, and the dead-letter tooling; validation caught it and it was fixed. Lesson recorded: every new BullMQ queue must be registered with the admin controller and the metrics collector, not just its own module.
- Vendoring JsSIP adds a ~1 MB static asset to the repo and a one-time `browserify` step to refresh it — an accepted cost for a self-hosted, CDN-free softphone.
