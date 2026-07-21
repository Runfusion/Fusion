---
"@runfusion/fusion": patch
---

summary: Keep dismissed GitHub Copilot re-login banners hidden permanently.
category: fix
dev: OAuthReloginBanner preserves the github-copilot dismissal across polling and successful-login events; other providers still re-arm after successful re-login.
