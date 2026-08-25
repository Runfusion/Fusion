---
"@runfusion/fusion": patch
---

summary: Fix engine dispatch hard-fails ("branchWriteOrigin is required") when re-pinning task worktrees and branches.
category: fix
dev: FN-9161's store validation rejects branch writes without an explicit origin (even null clears); engine call sites (fresh-create finalize, warm-reuse re-pin, pool acquire, branch-conflict reclaim/sticky-park, merge-reuse fallback, PR-conflict reclaim, resume-limbo reclaim, post-merge cleanup, workspace stale-routing clear, recovery metadata rewrite) were still writing bare {worktree, branch} and failing every affected dispatch/recovery write.
