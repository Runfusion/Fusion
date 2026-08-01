---
"@runfusion/fusion": patch
---

summary: Engine retries no longer re-queue a task into the column it is already sitting in on renamed boards.
category: fix
dev: Eight executor rebound guards compared `column !== "todo"` before moving to `resolveReboundColumnFor(...)`; they now resolve once and compare against that value. The FN-1404 `task:move` audit metadata records the resolved column instead of a hardcoded `"todo"`.
