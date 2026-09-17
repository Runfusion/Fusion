---
"@runfusion/fusion": patch
---

summary: Stop timed-out Pipeline smoke runs from leaving test work behind.
category: fix
dev: Uses bounded process-group cancellation for the Pipeline smoke pnpm-to-Vitest launch.
