---
"@runfusion/fusion": patch
---

Fix missions stalling when a feature is marked `done` but stranded mid-loop.

A mission feature could be left `status: "done"` while its `loopState` never advanced past `"implementing"` and it had no linked board task (so it was never validated). The slice-completion gate (`MissionStore.computeSliceStatus`) correctly refuses to count an assertion-linked `done` feature until its validator passes, but nothing re-drove a task-less feature, so the slice — and the whole mission — could never auto-progress.

Active-mission recovery now detects these stranded `done` features and re-runs assertion validation directly (no board task), so the gate can resolve: on pass the feature becomes legitimately complete, on fail the normal fix-feature flow takes over. The feature-validation path was extracted into a shared `runFeatureValidation` helper used by both task-completion and recovery.
