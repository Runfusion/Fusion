---
"@runfusion/fusion": minor
---

summary: Add a mission auto-merge override so a mission's features share one branch and one PR.
category: feature
dev: MissionManager create/edit tri-state control persists Mission.autoMerge; mission triage stamps task.autoMerge=false when the mission override is false. POST accepts autoMerge and PATCH null clears to inherited.
