---
"@runfusion/fusion": patch
---

Add targeted self-healing for orphan-only `FileScopeViolationError` failures: when an in-review failed task only staged out-of-scope orphan files and the task's work is positively verified as already landed on the base branch (Fusion-Task-Id lineage checks), Fusion now auto-finalizes the task as a no-op (`orphan-discard-no-op`) and discards orphan staging via worktree cleanup instead of requiring a manual retry click (FN-4350), while preserving FN-4280 guardrails by skipping recovery when landed-work evidence is absent.
