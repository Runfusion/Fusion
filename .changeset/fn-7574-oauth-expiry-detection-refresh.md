---
"@runfusion/fusion": patch
---

summary: Expired Claude subscription logins now show disconnected with a re-login prompt; tokens auto-refresh before expiry.
category: fix
dev: Unifies OAuth expiry detection between OAuthExpiryMonitor and /api/auth/status, and adds an engine-side proactive OAuth refresh scheduler wired in project-engine (guarded by skipNotifier). No token material logged.
