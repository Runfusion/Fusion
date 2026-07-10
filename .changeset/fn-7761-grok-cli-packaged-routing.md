---
"@runfusion/fusion": patch
---

summary: Route Grok CLI models through the logged-in grok CLI in packaged hosts without requiring GROK_API_KEY.
category: fix
dev: Eagerly ensures the bundled Grok runtime in serve/daemon/dashboard and blocks silent direct-endpoint fallback when no key is visible.
