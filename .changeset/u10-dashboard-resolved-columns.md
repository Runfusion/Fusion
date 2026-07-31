---
"@runfusion/fusion": patch
---

summary: Board, list, task detail, and move menus now render each card's own workflow columns.
category: fix
dev: U10 of the workflow-owned-lifecycle program (R8). Removes the legacy `COLUMNS` injection from Board's All-workflows lane union (it drew a phantom lane for every legacy column no workflow declared, labelled with the raw id, ordered by the legacy enum rather than the IR); ListView no longer silently drops a row whose stored column its workflow does not declare (display-only re-home to the intake lane, matching Board's existing safety nets); `getWorkflowMoveTargets` offers the workflow's recovery lane instead of an empty move list for a card stranded in an undeclared column; Task Detail's column badge and title/description edit gate resolve from the card's column traits with the legacy id set as fallback; `board-workflows`' built-in lifecycle label map became a fallback rather than an override (it was rendering `builtin:lead-generation`'s "Lead intake" as "Planning"); and the open-PR backward-move guard on `POST /tasks/:id/move` orders columns by the task's workflow instead of `COLUMNS.indexOf`, which returned -1 on any renamed board and disabled the guard entirely.
