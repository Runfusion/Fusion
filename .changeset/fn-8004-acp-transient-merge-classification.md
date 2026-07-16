---
"@runfusion/fusion": patch
---

summary: Auto-merge now retries AI provider blips instead of permanently failing the task.
category: fix
dev: ACP provider faults (`promptAcpSession` now preserves the JSON-RPC code as `acp rpc code -32603`) classify as transient via a new `ai-provider-turn-failure` class. `classifyTransientMergeError` also delegates to `isTransientError`, so the self-healing sweep and the inline retry gate share one definition — previously network errors got inline retries but were invisible to the sweep once parked `failed`. Pure predicates moved to the import-free leaf `transient-error-patterns.ts` (re-exported from `transient-error-detector.ts`) to keep the logger chain out of the classifier per FN-5627. Transient budgets raised: `MAX_AUTO_MERGE_TRANSIENT_RETRIES` 3→5, `MAX_TRANSIENT_MERGE_RECOVERIES` 2→5.
