---
"@runfusion/fusion": patch
---

summary: Starting Fusion no longer interrupts you with onboarding questions on a working install.
category: fix
dev: Two defects. (1) `maybeAutoLaunchOnboarding` probed `~/.fusion/fusion-central.db` to decide whether the install was initialized, but SQLite central was removed — a Postgres install never creates that file, so `centralDbExists` was permanently false and onboarding auto-launched on every interactive start until something stamped the completion marker. The probe now also accepts the embedded Postgres data directory. (2) Auto-launched onboarding ran the full interactive flow, so a dashboard or `pnpm dev --tunnel` start could stop dead on "Run ai provider setup now?" and never reach listening. `runOnboard` takes `interactive` (default true); auto-launch passes `false`, which creates the central database, stamps the marker, and points at the dashboard without asking anything. Explicit `fn onboard` keeps every step.
