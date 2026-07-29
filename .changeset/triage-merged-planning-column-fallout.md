---
"@runfusion/fusion": patch
---

summary: A task that already started work is no longer sent back to be re-planned after the Planning column merge.
category: fix
dev: U11 (#2515) fallout. With Todo merged into Planning, one column carries both intake and hold traits and discovery makes the branches disjoint by testing hold first — but only the intake rule ever had the `isTaskStillInPlanningStage` advancement guard, because a card in the old `todo` could not be mid-planning. An advanced card (worktree + execution stamps) whose PROMPT.md is missing therefore hit the ENOENT "treat as unplanned" branch and was re-dispatched for planning, discarding its work: the FN-7977 / FN-8594 class, reintroduced by the column merge. The guard now applies to both rules and is passed the task's RESOLVED intake column, so a rebounded `needs-replan` card resting in the merged column is still correctly re-admitted.
