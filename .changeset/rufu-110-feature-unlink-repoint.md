---
"@runfusion/fusion": minor
---

summary: Mission features: done-credit via reverse lineage, re-point/unlink tools, and live unlink SSE updates.
category: feature
dev: New `fn_feature_repoint_task` / `fn_feature_unlink_task` agent tools (engine + CLI) backed by an atomic `repointFeatureToTask` store primitive preserving single-valued `feature.taskId` and one-feature-one-task invariants; unlink of an unlinked feature errors clearly. Classified as mutation tools like `fn_feature_link_task`.