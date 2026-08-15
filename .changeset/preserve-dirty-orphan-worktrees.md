1|---
2|"@runfusion/fusion": patch
3|---
4|
5|summary: Preserve worktree content during automatic cleanup.
6|category: fix
7|dev: Idle cleanup revalidates registered worktrees without force; explicit pool reuse still reclaims its selected entry; missing registrations are pruned; unregistered cleanup removes only empty residue after Fusion-owned secret cleanup. A concurrently missing managed env is treated as already removed so its fingerprint can be cleared.
8|