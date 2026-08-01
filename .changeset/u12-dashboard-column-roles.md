---
"@runfusion/fusion": patch
---

summary: Fix board affordances that broke on renamed or merged column lineages.
category: fix
dev: Column-role helpers move to @fusion/core (column-roles.ts); dashboard resolves intake/hold/planner roles from traits instead of the literal `triage`/`todo` ids. Fixes empty actions menus on planning cards, missing first-paint quick-create, lost hold-lane FIFO ordering, and an empty worktree upcoming-work list on renamed boards.
