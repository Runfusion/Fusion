---
"@runfusion/fusion": patch
---

summary: Enforce explicit external checkout metadata for review routing.
category: fix
dev: Reviews now use sourceMetadata.externalReviewCheckout only when it points at a valid git checkout, otherwise they fail closed to the task worktree and log the selected review target.
