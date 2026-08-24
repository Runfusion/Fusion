---
"@runfusion/fusion": patch
---

summary: Remote login links no longer hand over the dashboard token, and a tunnel that cannot start says so.
category: security
dev: `/remote-login?rt=…` redirected to `/?token=<daemonToken>`, giving every recipient of a shared remote link the dashboard's real non-expiring credential in their URL and history — and making the separate remote token pointless, since revoking it left the recipient authenticated. It now mints an opaque, expiring, revocable session (`createRemoteSessionStore`) delivered as an HttpOnly/SameSite=Lax/Secure cookie, and redirects clean; the auth middleware accepts that cookie as a third credential source after header and `fn_token` query. Session TTL is capped by a short-lived remote token's remaining life, else the configured `shortLived.ttlMs` (default 15m). Separately, `POST /api/remote/tunnel/start` without an engine reported `state:"starting"` when nothing could start; it stays 200 and idempotent (a dashboard can run `--no-engine`) but now reports `stopped` with `REMOTE_TUNNEL_ENGINE_UNAVAILABLE`.
