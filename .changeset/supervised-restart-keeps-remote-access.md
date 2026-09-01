---
"@runfusion/fusion": patch
---

summary: Restarting Fusion no longer kills remote access — the Tailscale tunnel survives the restart.
category: fix
dev: A supervised restart (exit 86) now passes `stopAll({ supervisedRestart: true })`, which releases the tunnel child from `superviseSpawn`'s parent-death registry instead of stopping it; the relaunched process adopts a funnel proven live via `tailscale serve status --json` rather than spawning a competing one. Restore also keeps `remoteAccess.lifecycle.wasRunningOnShutdown` set through transient prerequisite/spawn failures.
