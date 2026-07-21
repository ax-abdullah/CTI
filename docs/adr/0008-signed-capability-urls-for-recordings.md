# ADR-0008: Signed capability URLs for recordings

**Status:** Accepted (Phase 5)

## Context

Recordings live on the PBX (`/var/spool/asterisk/monitor`). CRMs and webhook consumers need a link they can store on the activity record, but the PBX filesystem must never be exposed, and links get forwarded/leaked. Consumers include third-party systems that cannot hold our API keys.

## Decision

`call.ended` carries `recordingUrl`: a **capability URL** — `GET /v1/recordings/:token` where the token is an HMAC-signed payload embedding only the file **basename** and a **15-minute expiry**. The CTI streams the file from `RECORDINGS_BASE_DIR` (a mount/sync of the PBX monitor directory). No other credential is needed; tampered or expired tokens return 404; traversal is structurally impossible (basename-only, joined under the base dir).

## Consequences

- Any consumer that received the event can fetch the recording within the window — no key distribution problem; leaked links die in 15 minutes.
- Long-term CRM playback needs the consumer to download and re-store the file (Zoho/Salesforce activity enrichment does this), or a future re-signing endpoint.
- Availability depends on the recordings mount; with reverse-connector customers this means a share/sync until the tunnel file channel (ADR-0007) exists.
- Token secret rotation (`RECORDINGS_URL_SECRET`) instantly invalidates outstanding links — acceptable given the short TTL.
