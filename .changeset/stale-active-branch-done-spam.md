---
"@runfusion/fusion": patch
---

summary: Stop reclaim log spam for done-task squash branches and delete them after completion.
category: fix
dev: reclaimStaleActiveBranches force-deletes complete-lane leftovers with unique commits; clearCompletionBranchIfSubsumed force-deletes post-done (squash-safe).
