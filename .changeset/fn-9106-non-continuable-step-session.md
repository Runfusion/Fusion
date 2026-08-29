---
"@runfusion/fusion": patch
---

summary: Non-continuable agent sessions now recover cleanly in step-session runs instead of failing the task.
category: fix
dev: Pairs run-implementation.ts step-session error handling with handleNonContinuableSessionRetry.
