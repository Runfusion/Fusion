---
"@runfusion/fusion": minor
---

summary: Add per-sha revert commit granularity to the task revert API and service.
category: feature
dev: `performTaskRevert` and `POST /api/tasks/:id/revert` accept an optional `granularity: "squash" | "per-sha"` (default `"squash"`, unchanged FN-7523 behavior). `"per-sha"` creates one attributed `revert(FN-xxxx)` commit per original sha (each with its own `Fusion-Task-Id` trailer and audit line), skipping no-op shas without empty commits. A mid-batch conflict in either mode rolls back the whole batch to the pre-call HEAD — no partially-landed per-sha commits. The clean result now reports `revertCommitShas: string[]` (all created commits) alongside the existing `revertCommitSha` (kept for backward compatibility).
