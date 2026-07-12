---
"@runfusion/fusion": patch
---

summary: Stop false "OAuth token expired" push notifications for providers that silently refresh (e.g. GitHub Copilot).
category: fix
dev: OAuthExpiryMonitor.check() now attempts a best-effort getApiKey refresh and re-checks the credential before dispatching oauth-token-expired, mirroring /api/auth/status's refresh-then-recheck that drives OAuthReloginBanner. The FN-7574 start-refresher-first ordering only covered the startup check; short-lived auto-refreshing tokens still fired on interval ticks with no matching banner.
