---
"@dustinbyrne/kb": patch
---

Add archive functionality for completed tasks

Tasks can now be archived from the done column to keep the board focused on recent work while preserving historical tasks in an accessible but unobtrusive location.

**New CLI commands:**
- `kb task archive <id>` — Archive a done task
- `kb task unarchive <id>` — Restore an archived task to done

**Dashboard features:**
- New "Archived" column at the end of the board (collapsed by default)
- Archive/unarchive buttons on task cards (visible on hover)
- Archived tasks cannot be dragged or modified

**API endpoints:**
- `POST /api/tasks/:id/archive` — Archive a task
- `POST /api/tasks/:id/unarchive` — Unarchive a task
