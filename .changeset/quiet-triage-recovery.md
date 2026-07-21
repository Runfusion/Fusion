---
"@runfusion/fusion": patch
---

summary: Prevent Plan Review replans from stranding completed tasks in Triage and recover affected tasks automatically.
category: fix
dev: Preserves graph ownership during executor-authored replan moves and clears stale same-task session claims during recovery.
