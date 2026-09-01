---
"@runfusion/fusion": patch
---

summary: Fix task dispatch and recovery stalling when Fusion re-pins a task's worktree branch.
category: fix
dev: FN-9161's store validation rejects branch writes without an explicit origin (even null clears); engine call sites (fresh-create finalize, warm-reuse re-pin, pool acquire, branch-conflict reclaim/sticky-park, merge-reuse fallback, PR-conflict reclaim, resume-limbo reclaim, post-merge cleanup, workspace stale-routing clear, recovery metadata rewrite) were still writing bare {worktree, branch} and failing every affected dispatch/recovery write. Branch-value stamps now derive provenance from `classifyTaskBranchOrigin` so operator-provided branches keep `branchWriteOrigin: "operator"` and stay protected from engine branch cleanup; null clears keep explicit engine attribution. `classifyTaskBranchOrigin` additionally keeps the operator marker through numeric sibling renames (`-2`..`-50`) of a Fusion-named override branch, while engine derivatives (`-step-<i>`, `-stranded`) stay engine-owned.
