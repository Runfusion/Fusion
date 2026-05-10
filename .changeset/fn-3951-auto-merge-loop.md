---
"@runfusion/fusion": patch
---

Prevent auto-merge loops on terminal invalid done-transition failures during merge recovery.

When merge finalization encounters a non-recoverable state-machine error like
`Invalid transition: 'todo' → 'done'`, auto-recovery now keeps that task parked
in a stable failed review state instead of repeatedly re-enqueuing it for merge.

The merge-confirmed fast path also now re-checks task ownership and skips
finalization if the task has already left `in-review`.
