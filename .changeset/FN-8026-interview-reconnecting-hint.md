---
"@runfusion/fusion": patch
---

summary: Hide the interview reconnecting hint on persisted question and review screens.
category: fix
dev: Gate the shared reconnecting indicator in MissionInterviewModal/MilestoneSliceInterviewModal to view.type === "loading" and in SubtaskBreakdownModal to view.type === "generating", mirroring FN-8002 so idle awaiting-input screens render purely from persisted state.
