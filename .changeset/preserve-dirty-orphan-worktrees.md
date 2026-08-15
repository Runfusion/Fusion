---
"@runfusion/fusion": patch
---

summary: Preserve worktree content during automatic cleanup.
category: fix
dev: Idle cleanup revalidates registered worktrees without force; explicit pool reuse still reclaims its selected entry; missing registrations are pruned; unregistered cleanup removes only empty residue after Fusion-owned secret cleanup. A concurrently missing managed env is treated as already removed so its fingerprint can be cleared.
