---
"@runfusion/fusion": patch
---

summary: A persistent remote link no longer expires after 15 minutes.
category: fix
dev: The remote-login session fix capped every session at `shortLived.ttlMs`, so opening a PERSISTENT link yielded a 15-minute session — wrong for the link type operators use for their own devices. `resolveRemoteSessionTtlMs` now follows the token type: short-lived sessions still cannot outlive the token that authorised them (falling back to the configured TTL when there is no usable expiry), while persistent tokens mint a long session (30 days, and in-memory so a restart ends it regardless). Moved out of server.ts into remote-session.ts so the rule is unit-tested.
