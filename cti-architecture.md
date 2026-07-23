# CTI Platform — Asterisk/FreePBX ↔ CRM Integration

**Knowledge & architecture document** for building a multi-tenant Computer Telephony Integration (CTI) product: click-to-call, screen pops, and automated call logging between Asterisk/FreePBX servers and CRMs (Zoho CRM, Salesforce, and any custom CRM via generic webhooks).

- **Targets:** production FreePBX servers + the lab `Multi-Tenant-Asterisk-PBX` Docker project (prototyping)
- **Stack:** a dedicated **NestJS (TypeScript)** application — Redis for live call state, PostgreSQL for the tenant registry
- **Status:** design doc — no code yet. See the [Roadmap](#7-roadmap) for build phases.

---

## 1. What a CTI actually is

A CTI sits between the phone system and the business software and translates in both directions:

- **PBX → CRM:** "extension 1001 is ringing from +9665xxxxxxx" → *pop the matching contact card on the agent's screen*; "the call ended, 4m32s, recorded" → *log an activity on the contact*.
- **CRM → PBX:** agent clicks a phone number → *make the agent's desk phone ring, then dial the customer* (click-to-call).

So the whole product reduces to four capabilities:

1. **Listen** to call events from each PBX in real time.
2. **Correlate** low-level channel events into meaningful *calls* tied to *agents*.
3. **Command** the PBX (originate, and later: transfer, hangup, spy).
4. **Speak each CRM's dialect** for pops, dialing, and logging.

Everything else (multi-tenancy, auth, retries) is plumbing around those four.

---

## 2. The three Asterisk control surfaces

You need to know all three, because the product will end up using a mix.

### 2.1 AMI — Asterisk Manager Interface ✅ *primary choice*

A plain TCP socket (port **5038**) speaking a key/value line protocol. Two roles at once:

- **Event stream** — Asterisk pushes every call lifecycle event: `Newchannel`, `Newstate`, `DialBegin`, `DialEnd`, `BridgeEnter`, `BridgeLeave`, `Hangup`, `Cdr`, `NewCallerid`, plus device/extension state (`DeviceStateChange`, `ExtensionStatus`).
- **Action channel** — you send actions and get responses: `Originate` (click-to-call), `Redirect` (transfer), `Hangup`, `CoreShowChannels`, `ExtensionState`, `Getvar`/`Setvar`.

**Why it's the primary choice for this product:**
- **FreePBX ships with AMI enabled by default** (`manager.conf`, admin user in `/etc/asterisk/manager.conf`). Integrating with a customer's production FreePBX requires only adding a manager user + ACL — **zero dialplan changes**.
- It observes *all* calls on the box regardless of how they were routed. ARI only sees calls that are explicitly sent into a Stasis app.
- Screen pop + click-to-call + logging need observation and origination — exactly AMI's sweet spot.

**Its rough edges (you must design around these):**
- It's a **firehose**: a single 2-leg call emits 20+ events. You filter and correlate (see §3).
- Events are **channel-centric**, not call-centric.
- Auth is username/password with IP ACLs (`permit`/`deny`); TLS exists (port 5039, `tlsenable=yes`) but is often not enabled. **Never expose 5038 to the internet** — see §6.
- Event names/fields changed between Asterisk 12 (pre/post-Stasis-core). Everything modern (13, 16, 18, 20+) is consistent; FreePBX 15/16/17 = Asterisk 16/18/20+, so target the modern schema and don't bother supporting Asterisk ≤11.

### 2.2 ARI — Asterisk REST Interface

HTTP REST + a WebSocket (via Asterisk's built-in HTTP server, port **8088**/8089-TLS, configured in `http.conf` + `ari.conf`). Gives you *full call control*: you become the dialplan — answer, bridge, play media, record, snoop, all from your app (a "Stasis application").

**Why it is not the primary surface here:**
- ARI only receives events for channels **explicitly sent to `Stasis(yourapp)` in the dialplan** → you'd have to modify every customer's FreePBX dialplan and take responsibility for their call routing. That's invasive and risky for a bolt-on CTI.
- For pops/click-to-call/logging you never need to own media or bridging.

**When you'll want it later:** advanced features on PBXs you *do* control — in-call coaching/whisper, dynamic IVR driven by CRM data, call parking UIs. Keep the door open in the connector abstraction, don't build it now.

### 2.3 Dialplan-level hooks (AGI / `CURL()` / custom contexts)

The fallback when you can't get AMI at all (e.g., a hosted provider like Bevatel that won't open 5038):

- `extensions_custom.conf` on FreePBX exposes hook contexts (e.g. `[from-internal-custom]`, macro hooks like `[macro-dialout-trunk-predial-hook]`) where you can add a `CURL()` to notify your middleware, or run an AGI/FastAGI script.
- CDR backends (`cdr_adaptive_odbc`, or FreePBX's MySQL `asteriskcdrdb`) can be polled for after-the-fact logging when real-time isn't possible.

This is lossy (no rich mid-call state) but lets you sell "call logging + basic pop" even on locked-down PBXs. Document it as a degraded connector mode.

### 2.4 Decision summary

| Need | AMI | ARI | Dialplan hooks |
|---|---|---|---|
| See all calls, no dialplan changes | ✅ | ❌ (Stasis only) | ⚠️ partial |
| Click-to-call (`Originate`) | ✅ | ✅ | ⚠️ (call files — hacky) |
| Works on stock FreePBX out of the box | ✅ | ❌ (must enable http+ari) | ⚠️ needs config edits |
| Full call control / media | ❌ limited | ✅ | ❌ |
| **Verdict** | **Primary** | Later, for advanced features | Fallback for locked-down PBXs |

---

## 3. The event problem: from channels to calls

This is the hardest part of any Asterisk CTI and the core IP of the product. Raw AMI gives you *channels*; the CRM wants *calls*.

**Key identifiers on every AMI event:**
- `Uniqueid` — unique per **channel** (one leg).
- `Linkedid` — shared by **all channels belonging to the same call** (set to the Uniqueid of the first channel). **This is your call ID.** Group everything by `Linkedid`.
- `Channel` — e.g. `PJSIP/1001-00000042`; parse the endpoint (`1001`) to map to an agent.
- `CallerIDNum` / `ConnectedLineNum` — the two parties, from that channel's perspective.

**The state machine you must derive per call:**

```
            Newchannel (Linkedid born)
                    │
                    ▼
DialBegin ────► RINGING ── screen-pop event fires here
                    │
        ┌───────────┴──────────────┐
        ▼                          ▼
 BridgeEnter → ANSWERED      Hangup (no bridge) → MISSED / NO ANSWER / BUSY
        │                          │
        ▼                          │
   Hangup (all legs) ──────────────┴──► ENDED → Cdr event → log to CRM
```

**Rules of thumb learned the hard way (bake into the design):**

- **Direction detection:** a call is *inbound to an agent* when the ringing channel's endpoint matches a registered extension and the far end doesn't; *outbound* when the first channel of the Linkedid belongs to an extension. On FreePBX you can also read the context (`from-internal` vs `from-pstn`/`from-trunk`).
- **Ignore noise:** local channels (`Local/...`, used heavily by FreePBX for follow-me/queues) create phantom legs — track them but never surface them as calls. Same for `Announcer/`, `Message/`, music-on-hold bridges.
- **Queues and ring groups** ring N channels for one call: N `DialBegin`s, one `BridgeEnter`, N-1 `Hangup`s with cause 26 (answered elsewhere). Your pop logic must pop for *each ringing agent* and retract the pop (or mark "answered by X") when someone else takes it. AMI's `AgentCalled`/`AgentConnect` (app_queue events) help for true queues.
- **Transfers** re-parent channels: on blind/attended transfer, watch `BlindTransfer`/`AttendedTransfer` events — the Linkedid survives, but the agent mapping changes mid-call.
- **The `Cdr` event** (or `CEL` for finer grain) arrives at hangup with duration, billsec, disposition, and — on FreePBX — the recording filename in the `recordingfile` field of the CDR DB. This is your logging trigger.
- **State reconciliation:** on (re)connect, run `CoreShowChannels` to rebuild in-flight call state; never assume the event stream is gapless. Keep call state in **Redis with a TTL** (e.g., 6h) so a crashed worker doesn't leak "stuck" calls.

**The output of this layer is a small normalized event vocabulary** that every CRM adapter consumes:

```
call.ringing   { callId, tenantId, direction, agentExt, remoteNumber, remoteName?, queue? }
call.answered  { callId, answeredByExt, timestamp }
call.ended     { callId, disposition, durationSec, billsecSec, recordingUrl?, cdr }
agent.state    { ext, state }            // for presence, later
```

---

## 4. What each CRM expects

Three very different integration models — this is why the adapter layer must be a real abstraction, not an `if/else`.

### 4.1 Zoho CRM — PhoneBridge (server-side push)

- Zoho's telephony framework: you register as a **PhoneBridge partner/integration**, then your *server* calls Zoho's PhoneBridge REST APIs.
- **Screen pop:** you POST a "call notify" (ringing/answered/ended) to PhoneBridge with the caller number; **Zoho does the contact matching and renders the pop** inside Zoho CRM. You don't build UI.
- **Click-to-call:** Zoho shows the dial icon; clicking it makes Zoho call **your registered callback endpoint** with the number + Zoho user → you resolve Zoho user → agent extension → AMI `Originate`.
- **Logging:** call-ended notify auto-creates the call activity; you can enrich via the regular Zoho CRM REST API (attach recording link, notes).
- **Auth:** OAuth2 per customer org (authorization code flow, refresh tokens). Store per-tenant tokens encrypted; Zoho tokens are org+DC-scoped (`.com`, `.eu`, `.sa` DCs — Saudi DC exists and matters for your market).
- **Mapping requirement:** a table of *Zoho user ID ↔ agent extension* per tenant.

### 4.2 Salesforce — Open CTI (client-side softphone)

The inverse model: **you build the UI**, Salesforce hosts it.

- You create a **Call Center definition** (XML) pointing at a softphone page you host; admins assign users to it. Salesforce renders your page in an iframe (the softphone panel in Lightning).
- Your softphone page loads Salesforce's **Open CTI JS library** and talks to *your* NestJS backend over **WebSocket** for real-time events.
- **Screen pop:** on `call.ringing` for that agent, your page calls `sforce.opencti.searchAndScreenPop({ searchParams: callerNumber, ... })` — Salesforce searches its own records and pops.
- **Click-to-call:** `sforce.opencti.enableClickToDial()` + `onClickToDial(listener)` — Salesforce sends the clicked number to your page → your page hits your REST API → AMI `Originate`.
- **Logging:** your backend (or the page) creates a `Task` of type Call via the Salesforce REST API on `call.ended` (subject, duration, disposition, recording link, `WhoId` = matched contact).
- **Auth:** OAuth2 (per-org connected app) for the REST logging; the softphone page itself is authenticated by your own session (agent logs into your CTI once).
- **Mapping requirement:** *Salesforce user ↔ agent extension* per tenant.

### 4.3 Generic webhooks + REST (custom CRMs) — build this first

The lowest common denominator, and the fastest path to a demo:

- **Outbound:** signed `POST` per normalized event (`call.ringing`, `call.answered`, `call.ended`) to a per-tenant webhook URL. HMAC-SHA256 signature header (`X-CTI-Signature`), timestamp header, retries with exponential backoff + dead-letter (BullMQ).
- **Inbound:** `POST /v1/calls/originate { agentExt | agentId, number }` with per-tenant API key → AMI `Originate`. Plus `GET /v1/calls/:id` and `GET /v1/agents/:ext/state`.
- A custom CRM implements a pop with a 20-line webhook receiver + a browser push (or polls). This surface is also *exactly* what Phases 3–4 adapters consume internally — Zoho/Salesforce adapters are just privileged webhook consumers.

---

## 5. Architecture — the NestJS application

### 5.1 Topology

```mermaid
flowchart LR
    subgraph Tenant A
        FPBX1[FreePBX prod<br/>AMI :5038]
    end
    subgraph Tenant B
        AST1[Lab Asterisk Docker<br/>AMI :5038]
    end

    subgraph CTI [NestJS CTI Platform]
        direction LR
        CONN[PbxConnectorModule<br/>per-tenant AMI clients] --> NORM[CallStateModule<br/>correlation + state machine]
        NORM --> BUS[(Event bus<br/>BullMQ / EventEmitter)]
        BUS --> ZOHO[Zoho PhoneBridge adapter]
        BUS --> SF[Salesforce WS gateway]
        BUS --> WH[Webhook dispatcher]
        API[REST API<br/>click-to-call, admin] --> CONN
        TEN[TenantModule<br/>registry + credentials] -.-> CONN
        TEN -.-> ZOHO
        TEN -.-> WH
    end

    FPBX1 <--> CONN
    AST1 <--> CONN
    ZOHO --> ZCRM[Zoho CRM]
    SF <--> SFP[Softphone iframe<br/>in Salesforce]
    WH --> CCRM[Custom CRM]
    ZCRM -- click-to-call callback --> API
    REDIS[(Redis<br/>call state)] -.-> NORM
    PG[(PostgreSQL<br/>tenants, mappings, call log)] -.-> TEN
```

### 5.2 Module breakdown

| Module | Responsibility | Key tech |
|---|---|---|
| `PbxConnectorModule` | One AMI client per tenant PBX: connect, auth, keepalive, reconnect w/ backoff, `CoreShowChannels` resync on reconnect, raw-event → internal-event translation, `Originate` execution | `asterisk-ami-client` (or `asterisk-manager`), Nest lifecycle hooks |
| `CallStateModule` | Linkedid grouping, state machine (§3), local-channel filtering, direction detection, queue/transfer handling; emits the normalized vocabulary | Redis (call state, TTL), `@nestjs/event-emitter` |
| `TenantModule` | Tenant registry: PBX credentials (encrypted), CRM OAuth tokens, agent↔extension↔CRM-user mappings, webhook URLs + signing secrets, API keys | PostgreSQL via Prisma/TypeORM, `@nestjs/config` |
| `CrmAdaptersModule` | `CrmAdapter` interface (`onCallRinging/Answered/Ended`, `resolveClickToCall`) with Zoho, Salesforce, Webhook implementations; per-tenant fan-out | BullMQ queues per adapter (durable, retried) |
| `ApiModule` | REST: `/v1/calls/originate`, call queries, tenant/agent admin CRUD, Zoho click-to-call callback endpoint | Nest controllers, guards (API key / JWT) |
| `SoftphoneGateway` | WebSocket namespace for Salesforce softphone pages: agent auth, per-agent event push | `@nestjs/websockets` (socket.io or ws) |

**Design rules:**
- Adapters consume **only** the normalized events — no AMI types leak past `CallStateModule`.
- All CRM delivery goes through **BullMQ** (Redis-backed) so a CRM outage never blocks event processing; retries + dead-letter per tenant.
- The connector is an interface (`PbxConnector`) with the AMI implementation first — leaves room for an ARI or dialplan-hook connector later without touching anything downstream.

### 5.3 Flow 1 — inbound call → screen pop

```mermaid
sequenceDiagram
    participant PSTN as Caller (PSTN)
    participant PBX as FreePBX
    participant CONN as PbxConnector
    participant CS as CallState
    participant AD as CRM Adapter
    participant CRM as Zoho / SF / Custom

    PSTN->>PBX: Call to DID → rings ext 1001
    PBX->>CONN: AMI Newchannel + DialBegin (Linkedid L1)
    CONN->>CS: raw events
    CS->>CS: correlate L1, direction=inbound,<br/>agentExt=1001, filter Local/ legs
    CS->>AD: call.ringing {callId L1, +9665..., ext 1001}
    AD->>CRM: notify ringing (PhoneBridge API / WS push / signed webhook)
    CRM->>CRM: match contact by number → POP on agent screen
    PBX->>CONN: BridgeEnter
    CS->>AD: call.answered
    AD->>CRM: update pop → live call card + timer
```

### 5.4 Flow 2 — click-to-call

The **agent-leg-first** pattern: originate to the *agent's phone* first; when the agent picks up, Asterisk dials the customer. The agent never hears dead air and the CLI presented to the customer is correct.

```mermaid
sequenceDiagram
    participant CRM as CRM (button)
    participant API as CTI REST API
    participant CONN as PbxConnector
    participant PBX as FreePBX
    participant AG as Agent phone (1001)
    participant CU as Customer

    CRM->>API: POST /v1/calls/originate {number, crmUser}
    API->>API: resolve crmUser → tenant + ext 1001 (TenantModule)
    API->>CONN: originate(tenant, 1001, number)
    CONN->>PBX: AMI Action: Originate<br/>Channel=PJSIP/1001, Context=from-internal,<br/>Exten=number, CallerID=customer CLI, Async=true
    PBX->>AG: rings agent first
    AG->>PBX: agent answers
    PBX->>CU: dials customer
    PBX->>CONN: DialBegin/DialEnd/BridgeEnter events
    CONN->>CRM: normal event flow → CRM shows outbound call card
```

Notes: `Async: true` is mandatory (otherwise the AMI action blocks until answer); set `ChannelId`/`OtherChannelId` or a `Variable: CTI_CALL_REF=...` so the resulting channels are attributable to the API request; on FreePBX originate into `from-internal` so outbound routes/recording apply normally.

### 5.5 Flow 3 — call end → automated logging

```mermaid
sequenceDiagram
    participant PBX as FreePBX
    participant CONN as PbxConnector
    participant CS as CallState
    participant Q as BullMQ
    participant AD as CRM Adapter
    participant CRM as CRM

    PBX->>CONN: Hangup (all legs) + Cdr event
    CONN->>CS: raw events
    CS->>CS: finalize call: disposition, duration,<br/>billsec, recording ref
    CS->>Q: enqueue call.ended (per-tenant, per-adapter)
    Q->>AD: deliver (retry on failure)
    AD->>CRM: create call activity/Task<br/>(contact match, duration, recording URL, agent)
    AD->>AD: on repeated failure → dead-letter + alert
```

Recording links: FreePBX stores recordings under `/var/spool/asterisk/monitor/...` with the filename in the CDR. Serve them through a small authenticated proxy endpoint on the CTI (per-tenant signed URLs) rather than exposing the PBX.

### 5.6 Multi-tenancy model

- **Tenant registry (PostgreSQL):** tenant → N PBX connections (host, AMI port, username, encrypted secret, TLS mode) → N agents (extension, display name, per-CRM user IDs) → CRM configs (type, OAuth tokens / webhook URL + HMAC secret / API keys).
- **Connection isolation:** one AMI client per PBX, supervised (Nest lifecycle + reconnect backoff + health state exposed on `/health`). A misbehaving tenant PBX must not affect others — wrap each connector in its own error domain; consider per-tenant worker processes only if scale demands it later.
- **Event routing:** every internal event carries `tenantId` from the connector that produced it; adapters look up tenant CRM config at delivery time.
- **The NAT problem (important for productization):** customer FreePBX boxes are usually behind NAT/firewalls — the cloud CTI can't reach 5038. Two deployment modes to support:
  1. **Direct** — customer opens 5038/5039-TLS to your static IPs (ACL'd) or you peer via VPN/WireGuard. Fine for early customers.
  2. **Reverse connector (later)** — a tiny on-prem agent (could be a single binary or container) that dials *out* to the cloud over TLS/WebSocket and proxies AMI. This is how commercial CTIs solve it; design the `PbxConnector` interface so this slots in.

---

## 6. Security checklist

- **AMI:** dedicated manager user per integration with **minimal `read`/`write` classes** (`read = call,cdr,dialplan`, `write = originate,call` — not `all`); `permit` ACLs pinned to the CTI's IPs; prefer TLS (5039) or VPN; never expose 5038 publicly (it's a remote-code-execution surface via `Originate`+`System` if `write=system` is granted — never grant it).
- **Secrets at rest:** PBX passwords and CRM OAuth refresh tokens encrypted (per-tenant data key, e.g. libsodium sealed boxes); never in env files per tenant.
- **Webhooks out:** HMAC-SHA256 signature + timestamp (reject >5min skew) so customer CRMs can verify authenticity.
- **API in:** per-tenant API keys (hashed at rest) for the generic REST; JWT sessions for softphone WebSocket auth; rate-limit `originate` (it makes phones ring — abuse vector).
- **Recordings:** served only via short-lived signed URLs through the CTI proxy; PBX filesystem never exposed.
- **Multi-tenant hygiene:** every query and every event handler filters by `tenantId`; write tests specifically for cross-tenant leakage.

---

## 7. Roadmap

| Phase | Scope | Exit criterion |
|---|---|---|
| **0 — Lab prep** | Add `manager.conf` (+ expose 5038) to `LAB/Multi-Tenant-Asterisk-PBX` Docker config; create a `cti` manager user with minimal ACLs | `telnet localhost 5038` login works; events visible on a test call between 1001↔1002 |
| **1 — Core (single tenant)** | Scaffold NestJS app in `LAB/CTI/`; `PbxConnectorModule` + `CallStateModule` + normalized events; generic webhook dispatcher; `POST /v1/calls/originate` | Demo: call 1001→1002 fires signed webhooks; curl originates a call; webhook consumer shows a pop |
| **2 — Multi-tenant + production FreePBX** | Tenant registry (PostgreSQL), encrypted creds, BullMQ delivery, `/health`, agent↔extension mapping, point at a real FreePBX | Two tenants (lab + prod FreePBX) running concurrently, isolated, with per-tenant webhooks |
| **3 — Zoho PhoneBridge** | OAuth per org, call-notify integration, click-to-call callback endpoint, activity enrichment | Ringing pop inside Zoho; dial icon in Zoho rings the agent's phone; ended call logged |
| **4 — Salesforce Open CTI** | Softphone page + Call Center XML, `SoftphoneGateway` WebSocket, `searchAndScreenPop`, click-to-dial, Task logging | Same three features working inside Salesforce Lightning |
| **5 — Productization** | Reverse on-prem connector, recording proxy, admin UI, per-tenant dashboards, presence (`agent.state`) | Installable at a customer without inbound firewall holes |

> **What's next:** Phases 0–5 are complete and merged. The forward roadmap (Phase 6+ — production hardening then WebRTC/ARI expansion) lives in [docs/ROADMAP.md](./docs/ROADMAP.md).

### Suggested libraries

- AMI: [`asterisk-ami-client`](https://www.npmjs.com/package/asterisk-ami-client) or [`asterisk-manager`](https://www.npmjs.com/package/asterisk-manager) (both mature; wrap behind your own interface regardless)
- Queue: `@nestjs/bullmq` + BullMQ; Events: `@nestjs/event-emitter`
- DB: Prisma (or TypeORM) + PostgreSQL; Redis via `ioredis`
- WebSocket: `@nestjs/websockets` + `socket.io`

---

## 8. Open questions to resolve before Phase 2

1. **Zoho PhoneBridge partner registration** — the full PhoneBridge API requires registering the integration with Zoho (marketplace/partner flow). Start the application early; the generic webhook path is the fallback while it's pending.
2. **Salesforce org access** — need a Developer Edition org for Phase 4 development (free, but set it up early to build the Call Center XML + connected app).
3. **CLI/CallerID policy per tenant** — what caller ID to present on click-to-call (trunk rules live on the PBX; the CTI just requests).
4. **Data residency** — Saudi customers + Zoho `.sa` DC + recordings storage location; affects where the platform is hosted.
