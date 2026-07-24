---
"@runfusion/fusion": patch
---

summary: Switching projects now dismisses the old project's modals and resets Planning and subtask breakdown to the new project.
category: fix
dev: New `closeProjectScopedModals()` on the modal manager, invoked by project select/view-all/setup-complete; embedded PlanningModeModal and SubtaskBreakdownModal are keyed by project id so running streams, session lists, and per-project persisted drafts/active sessions no longer leak across projects (subtask drafts save on unmount under their own project key).
