---
"@runfusion/fusion": patch
---

summary: Overhaul first-run setup: connected providers on top, state-driven GitHub step, fixed isolation-mode radios, deduped runtime-node picker.
category: fix
dev: New setupWizardNodes.ts (getSelectableRuntimeNodes/shouldShowRuntimeNodeSelector) shared by SetupWizardModal and SetupProjectForm; GitHub status revalidates on window focus and OAUTH_RELOGIN_SUCCESS_EVENT; 4 new i18n keys.
