---
"@runfusion/fusion": patch
---

summary: Preserve worktree content during automatic cleanup.
category: fix
dev: Registered idle and pool-prune cleanup revalidates and preserves tracked, untracked, and ignored content without force. Native non-defensive removals retain their legacy forced default; Worktrunk receives force only from explicit caller intent. Missing registrations are pruned; unregistered cleanup removes only empty residue after Fusion-owned secret cleanup; a concurrently missing managed env clears its fingerprint.
