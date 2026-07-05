---
"@runfusion/fusion": patch
---

summary: New tasks created under the Coding (Ideas) workflow now land in the Ideas column and wait for you to promote them.
category: fix
dev: Dashboard create surfaces (InlineCreateCard, QuickEntryBox, NewTaskModal, insight/todo → task) no longer hard-code column:"triage"; the store now resolves the selected/default workflow's intake column. InlineCreateCard forwards workflowId at create time instead of applying it post-create. Also fixed a glue-layer regression in `useTaskHandlers.ts` (`handleBoardQuickCreate`/`handleModalCreate`) that re-forced column:"triage" even after the UI surfaces stopped sending it.
