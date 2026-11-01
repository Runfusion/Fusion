---
"@runfusion/fusion": patch
---

summary: Cards blocked by a stale "branch already checked out" error now unblock themselves once Git says the conflict is gone.
category: fix
dev: New self-healing sweep `reconcile-stale-acquisition-conflicts` (startup + git-churn maintenance cadence, pause-gated) re-derives the conflict from live git and clears exactly `{status:null,error:null}` in place through a fenced `updateTaskAtomic` when the premise is provably absent — no `moveTask`, no branch/worktree wipe, no counter reset. Emits `task:reconcile-stale-acquisition-conflict` / `-no-action` with ids and fixed enums only; live registrations, leftover destination content, foreign or unattributable tip commits, unreadable repositories, paused and workspace cards stay fail-closed.
