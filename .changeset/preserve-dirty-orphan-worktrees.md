---
"@runfusion/fusion": patch
---

summary: Preserve worktree content during automatic cleanup.
category: fix
dev: Idle cleanup and pool-prune paths revalidate registered worktrees without force; missing registrations are pruned; unregistered cleanup removes only empty residue after Fusion-owned secret cleanup. A concurrently missing managed env is treated as already removed so its fingerprint can be cleared.
