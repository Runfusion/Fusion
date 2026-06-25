---
"@runfusion/fusion": minor
---

summary: Verification now runs only the tests affected by a task's changed files, so merge/step checks finish in seconds.
category: feature
dev: New deriveFileScopedPnpmTestCommand maps changed test files (and co-located tests of changed source) to a per-package `pnpm --filter <pkg> exec vitest run <files>` command; inferDefaultTestCommand uses it (overriding even an explicit testCommand) when the new project setting scopeVerificationToChangedFiles (default true) is on and git context is available, falling back to the configured command when no tests resolve. The thin merge-gate suite remains the cross-cutting safety net.
