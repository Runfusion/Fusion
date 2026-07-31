---
"@runfusion/fusion": patch
---

summary: Stop self-healing pausing cards whose planning session is still running, and unstick queued planning.
category: fix
dev: Planning sessions now claim their worktree through `acquireActiveSessionPath` (new `"planning"` kind) and release it only when they still own the record, so the FN-4819 liveness guard in the self-owned-branch reclaim sweep defers instead of removing a live worktree and escalating to `branch-conflict-unrecoverable` — and planning's teardown cannot clear an executor entry that took over the same path. `ProjectAdmissionCoordinator.admitOldest` walks past candidates whose lane declines rather than ending the pass on `candidates[0]`, unwinding each declined attempt's pre-held executor slot and reservation. Withheld planning admission emits a deduped `task:plan-admission-throttled` run-audit event (ids/counts only), written fire-and-forget with the dedupe marker set only after the write lands.
