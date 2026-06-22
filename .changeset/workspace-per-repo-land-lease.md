---
"@runfusion/fusion": minor
---

Workspace mode (Phase C U3): serialize concurrent same-sub-repo lands with a per-repo file-scope lease. When two workspace tasks try to land onto the SAME sub-repo's local integration ref at the same time, the merge phase now registers the sub-repo's absolute path in the path-keyed active-session registry under a distinct `workspace-repo-land` kind before each land and releases it in a `finally` (on land success or failure — no stuck lock). A second task contending for the same sub-repo fast-fails with a retryable `WorkspaceRepoLandBusyError`, which the existing partial-land auto-retry-then-park dispatch handles (consume a `mergeRetry`, re-enqueue with backoff, then operator-park). Disjoint sub-repos lease different paths and never serialize against each other. The lease prevents clean-room ai-merge worktree collisions; ref correctness is already guaranteed by `advanceIntegrationBranchRef`'s CAS (concurrent-advance → rebuild).
