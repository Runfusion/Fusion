---
"@runfusion/fusion": patch
---

Engine: when an in-review task moves to done (auto-merger, self-healing, or manual move), the engine now fans out blockedBy reconciliation and residual branch/worktree cleanup in the same pass instead of waiting for the next periodic self-healing sweep. Prevents FN-4008-class stranded-task incidents.
