---
"@runfusion/fusion": patch
---

summary: Archiving a task now releases its active-session lock so the next task can run Plan Review.
category: fix
dev: task:moved handler in packages/engine/src/executor.ts now disposes active surfaces and sweeps activeSessionRegistry paths for any move to the terminal "archived" column (previously only from==="in-progress"); done/in-review merge leases are deliberately untouched.
