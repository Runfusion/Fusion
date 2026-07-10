---
"@runfusion/fusion": patch
---

summary: Harden the dashboard server so provider API keys keep persisting even if a host forgets to wire auth storage.
category: fix
dev: createServer() now derives a fallback authStorage from engine.getAuthStorage() (new ProjectEngine getter exposing its createFusionAuthStorage() instance) when options.authStorage is absent, mirroring the existing engine-derivation of onMerge/automationStore/etc. Explicit authStorage still overrides. Prevents regression of the desktop "keys don't persist / Authentication is not configured" gap (#1948); the desktop path's wrapped authStorage (FN-7622) is unchanged.
