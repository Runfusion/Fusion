---
"@runfusion/fusion": patch
---

summary: Keep dismissed OAuth re-login banners hidden until successful re-login (fixes Copilot flicker).
category: fix
dev: OAuthReloginBanner no longer prunes fusion:oauth-relogin-dismissed when a provider leaves the expired set after silent refresh; OAUTH_RELOGIN_SUCCESS_EVENT clears that provider's dismissal to re-arm.
