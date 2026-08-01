---
"@runfusion/fusion": patch
---

summary: Spawned child agents now count against the worktree cap, not only the agent cap.
category: fix
dev: fn_spawn_agent's own note said a child consumes both dimensions but gated only agents — a fan-out could exceed maxWorktrees to the agent limit. The worktree check runs after the synchronous slot reservation (preserving the anti-TOCTOU ordering, proven by the racing-spawns test) and unwinds it on refusal.
