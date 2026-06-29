---
"@runfusion/fusion": patch
---

summary: Keep workflow merge nodes moving even when a workflow skips a review handoff.
category: fix
dev: Workflow merge primitives now establish the in-review merge boundary before requesting merge; non-gate skill output no longer requires a verdict.
