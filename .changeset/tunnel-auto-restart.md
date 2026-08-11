---
"@runfusion/fusion": patch
---

summary: Tunnels now restart automatically with backoff after crashing, instead of staying failed until manually restarted.
category: fix
dev: `TunnelProcessManager` gains `autoRestart` (default on), `restartBaseDelayMs`, `restartMaxDelayMs`; explicit stop or provider switch cancels any pending restart; exit/readiness handlers are guarded by process-handle identity so stale events cannot clobber a restarted tunnel.
