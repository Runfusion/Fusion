---
"@runfusion/fusion": patch
---

Fix `PATCH /tasks/:id` silently dropping task priority updates. The route handler in the dashboard server was destructuring every editable field from the request body except `priority`, so changing a task's priority via the dashboard task-detail modal had no effect on disk. The handler now accepts `priority`, validates it against the allowed values (`urgent`, `high`, `normal`, `low`) — `null` resets to the default — and forwards it to `store.updateTask`. Combined with the priority-aware merge queue and sweep ordering shipped earlier, dashboard priority changes now actually shift triage, scheduling, and merge order.
