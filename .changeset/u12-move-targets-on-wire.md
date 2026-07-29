---
"@runfusion/fusion": patch
---

summary: Move menus on custom workflows now offer exactly the moves that workflow allows.
category: fix
dev: The board-workflows payload gains a per-column `moveTargets` array from `resolveAllowedColumns` — the same resolver `moveTaskInternal` validates against. `getTaskMoveTransitions` reads it instead of approximating targets from neighbouring columns, and the `VALID_TRANSITIONS` default-column-set shortcut is deleted; `builtin-adjacency-matches-legacy-transitions.test.ts` pins the equivalence that made deleting it safe. Optional on the wire, so an older client keeps the neighbour fallback.
