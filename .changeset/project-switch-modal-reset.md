---
"@runfusion/fusion": patch
---

summary: Switching projects now fully resets Planning, Chat, Missions, subtask breakdown, GitHub import, and open modals.
category: fix
dev: New `closeProjectScopedModals()` on the modal manager plus an App-level composite reset invoked by project select/view-all/setup-complete that also dismisses popped-out task FloatingWindows, main-panel task detail, the right-dock task, and the Quick Chat window; PlanningModeModal, ChatView, MissionManager, SubtaskBreakdownModal, and GitHubImportModal are keyed by project id so running streams, session lists, and per-project persisted drafts/active sessions no longer leak or mis-file across projects (subtask/mission drafts save on unmount under their own project key).
