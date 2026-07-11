---
"@runfusion/fusion": patch
---

summary: Polish first-run setup: connected providers first, state-driven GitHub step, fixed radios, deduped node picker.
category: fix
dev: New setupWizardNodes.ts (getSelectableRuntimeNodes/shouldShowRuntimeNodeSelector) shared by SetupWizardModal and SetupProjectForm; GitHub status revalidates on window focus and OAUTH_RELOGIN_SUCCESS_EVENT; 4 new i18n keys.
