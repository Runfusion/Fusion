---
"@runfusion/fusion": patch
---

summary: Post-merge verification no longer holds landed tasks in review because of unrelated failing tests.
category: fix
dev: Post-merge REVISE now blocks only with `blockingReason` `task-regression` or `evidence-pending`; any other post-merge REVISE is recorded as APPROVE_WITH_NOTES at the engine parse boundary.
