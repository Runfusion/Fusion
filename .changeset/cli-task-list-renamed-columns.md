---
"@runfusion/fusion": patch
---

summary: Fix `fn task list` silently omitting cards in renamed or custom workflow columns.
category: fix
dev: `runTaskList` iterated the legacy six-id `COLUMNS` constant and filtered `t.column === col`, so a card in a workflow-defined column matched no iteration and was never printed. Lanes now come from the tasks themselves via the exported `boardColumnsForDisplay`, and the terminal glyph resolves via `resolveProjectColumnsForRoles(TERMINAL_ROLES)` with the legacy pair as a fail-soft fallback.
