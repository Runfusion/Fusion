---
"@runfusion/fusion": patch
---

summary: Show one completion summary in Review and remove the empty Merge section.
category: fix
dev: `buildTaskHistory` recognizes completion-summary and documentation-delivery projection ids, classifies them deterministically into Review, emits verdict-free and status-free entries to suppress report badges, and prefers the cleaned `task.summary` body. The obsolete `taskHistory.stage.merge` and `taskHistory.empty.merge` localization keys are removed.
