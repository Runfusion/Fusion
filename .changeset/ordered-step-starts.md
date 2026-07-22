---
"@runfusion/fusion": patch
---

summary: Prevent executors from starting ordered task steps before their required predecessors finish.
category: fix
dev: Applies dependency-aware ordering to both in-progress and done step transitions.
