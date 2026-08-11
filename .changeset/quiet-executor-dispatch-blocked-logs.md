---
"@runfusion/fusion": patch
---

summary: Stop the engine log repeating dispatch-blocked and symbol-lock-loss lines every poll for a stuck task.
category: fix
dev: Shared `createRepeatSuppressedLog` (packages/engine/src/util/repeat-suppressed-log.ts) backs the executor's unmet-dependency/ephemeral-disabled pre-dispatch gates and the scheduler's symbol-lock renewal: first occurrence per task/signature logs at full level, identical repeats drop to `debug()` (`FUSION_DEBUG=executor,scheduler`), a changed signature logs again, and the memo clears when the condition resolves. Symbol-lock loss also gated its per-poll `store.logEntry` append on the same decision.
