---
"@runfusion/fusion": patch
---

summary: Prevent workflow tasks from completing with stale or partial merge proof.
category: fix
dev: Workflow finalization now validates incomplete steps, no-op proof, and branch file coverage before done.
