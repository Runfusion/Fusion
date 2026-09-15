---
"@runfusion/fusion": patch
---

summary: The workflow dropdown now only switches workflows, and editing always opens the Workflows page.
category: fix
dev: FN-407. `WorkflowSwitcher` drops the `onEditWorkflow`/`onCreateWorkflow` props, the per-row edit rail, the persistent "New workflow" popover footer, and their CSS plus the `workflowSwitcher.editWorkflow`/`workflowSwitcher.newWorkflow` keys; `Board`, `ListView`, `HeaderWorkflowSwitcherSlot`, `GraphWorkflowSwitcherSlot`, and `PlanningWorkflowSwitcherSlot` drop the matching props. `WorkflowNodeEditor` loses its `presentation` prop, `FloatingWindow` host, `ModalCloseButton`, Escape-to-close, and `workflows.closeEditor` key; it renders only as the embedded Workflows view. `useModalManager` replaces `workflowEditorOpen`/`openWorkflowEditor`/`closeWorkflowEditor` with `workflowViewPanel`/`workflowViewWorkflowId`/`setWorkflowViewParams`/`clearWorkflowViewParams`, and `openCreateWorkflowWithNav` is removed. The `WorkflowNodeEditor` lazy chunk is re-homed from `AppModals.tsx` to `App.tsx`; the curated Lazy-Loaded Heavy Views count stays at 22. On mobile the header back control now walks workflow → workflow list → board (`workflows.backToBoard`).
