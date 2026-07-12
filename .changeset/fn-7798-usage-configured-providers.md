---
"@runfusion/fusion": patch
---

summary: Usage view now shows meters only for AI providers you have configured.
category: fix
dev: fetchAllProviderUsage() in packages/dashboard/src/usage.ts filters providers with no resolved credentials and no meterable entitlement (e.g. GitHub 404 "No Copilot subscription found" reclassified error→no-auth); configured-but-failing providers (auth expired / HTTP 5xx / timeout) remain visible.
