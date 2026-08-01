---
"@runfusion/fusion": patch
---

summary: Planning and spawn capacity stop counting finished cards' worktrees on renamed boards.
category: fix
dev: Both gates resolve terminal lanes via `resolveProjectColumnsForRoles(store, TERMINAL_ROLES)` instead of comparing `"done"`/`"archived"`.
