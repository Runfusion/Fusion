---
"@runfusion/fusion": patch
---

Repair task-store startup and self-healing consistency by non-destructively re-importing orphaned live `.fusion/tasks/{ID}/task.json` records into the SQLite task index while preserving soft-deleted, archived, and tombstoned IDs.
