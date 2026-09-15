---
"@runfusion/fusion": patch
---

summary: Mission interviews open in the detail pane, and Planning renames from the session row.
category: fix
dev: MissionManager renders `interviewSurface` inside `.mission-manager__detail-pane` instead of swapping `managerBody`, gates `ViewHeader.backAction` on `isMobile`, and passes `headingLevel={3}` to `MissionInterviewModal`. PlanningModeModal replaces `isRenamingSession` with `renamingSessionId` and renders `.planning-sidebar-item-rename` beside `.planning-sidebar-item-delete`.
