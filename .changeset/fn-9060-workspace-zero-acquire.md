---
"@runfusion/fusion": patch
---

summary: Workspace tasks with no acquired sub-repo now complete or fail review consistently.
category: fix
dev: Uses classifyWorkspaceZeroAcquire and the retryable review seam flag to avoid deterministic retry exhaustion.
