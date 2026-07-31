---
"@runfusion/fusion": minor
---

summary: Spawned child agents now count against Max Concurrent Tasks instead of a hidden spawn budget.
category: breaking
dev: Deletes `maxSpawnedAgentsPerParent` (5) and `maxSpawnedAgentsGlobal` (20). `fn_spawn_agent` now gates on the project agent count via `computeTopLevelConcurrencyClaimedFromStore` plus live children. Children were previously counted by neither capacity gate despite each getting its own git worktree, so a fan-out could add up to 20 worktrees while the scheduler believed the project was at its limit. The old per-parent budget also measured cumulative spawns over a task's life rather than concurrent ones, because the per-parent set was cleared only when the parent task ended.
