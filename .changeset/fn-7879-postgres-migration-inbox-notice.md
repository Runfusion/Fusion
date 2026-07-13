---
"@runfusion/fusion": minor
---

summary: Deliver a one-time inbox notice about the upcoming Postgres storage migration on first 0.59 startup.
category: feature
dev: New best-effort, idempotent `deliverPostgresMigrationNoticeIfNeeded` in `@fusion/engine`, invoked from `ProjectEngine.start()`; gated to version `0.59.x` via injected `cliPackageVersion` (threaded through `EngineManagerOptions`/`ProjectEngineOptions`); idempotency via inbox `metadata.kind = "postgres-migration-notice"` marker. Links to Discord (`https://discord.gg/ksrfuy7WYR`).
