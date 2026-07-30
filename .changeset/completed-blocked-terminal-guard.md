---
"@runfusion/fusion": patch
---

summary: Completed work resting in a renamed Done or Archived column is no longer moved back to planning.
category: fix
dev: `parkCompletedBlockedTask`'s terminal check resolves the workflow's complete/archived columns instead of comparing against the literals; fail-soft to `["done","archived"]`, and an unclassifiable column is not treated as terminal.
