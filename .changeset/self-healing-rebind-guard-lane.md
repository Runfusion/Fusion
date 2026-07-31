---
"@runfusion/fusion": patch
---

summary: Lost branch bindings are repaired again on boards with renamed columns.
category: fix
dev: `reconcileInReviewBranchRebind` reads the whole board and then filtered by the literal `in-review`, so on a renamed board it repaired nothing. The filter now resolves each card against its own workflow, falling back to the project's review columns when a card's workflow cannot be read.
