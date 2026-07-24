---
"@runfusion/fusion": patch
---

summary: Switching projects now dismisses the previous project's modals and resets the Planning view to the new project.
category: fix
dev: New `closeProjectScopedModals()` on the modal manager, invoked by project select/view-all/setup-complete; embedded PlanningModeModal is keyed by project id so a running plan's stream, session list, and persisted active session no longer leak across projects.
