---
"@runfusion/fusion": patch
---

summary: Auto-recover durable agents stuck in transient error state even when their manager is active.
category: fix
dev: SelfHealingManager durable-error recovery no longer requires a missing manager; manager-present durable non-ephemeral agents with a transient lastError and no active run are recovered under the existing cooldown/backoff/retry-budget guards (FN-7672).
