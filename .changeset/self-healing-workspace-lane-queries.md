---
"@runfusion/fusion": patch
---

summary: Workspace tasks finish their partial lands and release their worktrees on renamed boards.
category: fix
dev: `reconcileWorkspacePartialLands` and `reconcileOrphanedWorkspaceWorktrees` read the literal `in-review`/`done`, so on a renamed board a workspace task stranded mid-land was never re-enqueued and a finished one never released its per-repo worktrees. Reads resolve via `resolveProjectColumnsForRoles` (review roles, and `complete` only for the cleanup); the partial-land per-card check resolves per card.
