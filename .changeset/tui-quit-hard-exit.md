---
"@runfusion/fusion": patch
---

summary: Pressing q (or Ctrl+C) in the TUI now always quits, even if a teardown step stalls.
category: fix
dev: dashboard.ts shutdown/devShutdown arm an unref'd 3s hard-exit watchdog on the first signal and force an immediate process.exit(0) on a second signal, so a hung stopAllDevServers/engine/central-core teardown can no longer leave the process alive repainting the restored shell. Each teardown step now runs through timeShutdownStep, which tracks the in-flight step so the watchdog names the exact stalling step on stderr; set FUSION_DEBUG_SHUTDOWN=1 for per-step timings (slow steps >1s are always surfaced).
