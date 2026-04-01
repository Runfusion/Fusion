---
"@gsxdsm/fusion": minor
---

Add bulk model editing to dashboard list view

Users can now efficiently update AI model configuration for multiple tasks at once through the dashboard list view:

- Select multiple tasks via checkboxes in the list view
- New "Bulk Edit Models" toolbar appears when tasks are selected
- Choose executor and/or validator models from dropdowns
- Apply changes to all selected tasks in a single action
- Selection persists in localStorage across page reloads
- Archived tasks are excluded from bulk editing

New API endpoint: `POST /api/tasks/batch-update-models`
