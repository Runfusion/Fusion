---
"@runfusion/fusion": patch
---

summary: Fix Grok ACP startup by making --no-auto-update opt-in.
category: fix
dev: Released Grok CLI v1.0.0 rejects --no-auto-update; buildGrokAcpArgs now only pushes it when noAutoUpdate === true. Updated acp-settings.test.ts.
