---
"@runfusion/fusion": patch
---

summary: Remove the per-card overseer-state ("Executor") badge from task cards.
category: fix
dev: Deleted the FN-7516 `card-overseer-state-badge` render, its card-local `deriveOverseerCardWatchedStage` helper/label maps, and its CSS; the sibling oversight-level badge (`card-oversight-badge`) is unaffected.
