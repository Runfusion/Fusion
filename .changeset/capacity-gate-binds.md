---
"@runfusion/fusion": patch
---

summary: Column WIP limits are now actually enforced — a move into a full column is refused instead of silently allowed.
category: fix
dev: The in-transaction capacity check in `moveTaskInternal` sat inside `if (useWorkflow && …)`, reading `experimentalFeatures.workflowColumns`, which has no production writer — so the block never ran for real projects and `maxConcurrent` was unenforced at the store level. Only the CAPACITY check is un-gated; transition validation keeps its current flag-gated behavior, so the Phase A2 rejection-type/message divergences are untouched. Rejections surface as `capacity-exhausted`, which `hold-release` already reserves slots against and retries next sweep.
