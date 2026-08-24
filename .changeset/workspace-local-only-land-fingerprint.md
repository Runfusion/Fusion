---
"@runfusion/fusion": patch
---

summary: Fix local-only workspace merges failing after a repo landed, and repair the workspace review-approval fence.
category: fix
dev: `computeReviewDiffFingerprint` takes an optional `headRef`; `captureWorkspaceReviewEvidence` passes the resolved task branch so the fingerprint measures the same range as the file list it accompanies. `landWorkspaceTask` now resolves a workspace land intent only for remote targets, matching where `landOneRepo` records one.
