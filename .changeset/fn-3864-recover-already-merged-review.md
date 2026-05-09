---
"@runfusion/fusion": patch
---

Add `recoverAlreadyMergedReviewTasks()` self-healing sweep to recover phantom-merge-guard false positives. Detects tasks whose content already landed on the integration branch (via Fusion-Task-Id trailer, branch ancestry, or git patch-id walk) and reconciles them to `done` with proper merge metadata.
