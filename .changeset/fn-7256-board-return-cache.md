---
"@runfusion/fusion": patch
---

summary: Reuse fresh task data when returning to Board or List views.
category: fix
dev: Skips the useTasks false-to-true SSE catch-up fetch while the in-memory snapshot is within SWR_TASKS_MAX_AGE_MS.
