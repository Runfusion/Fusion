---
"@runfusion/fusion": patch
---

summary: Keep unresolved merge-review blockers active across concurrent-main rebuilds and later retries.
category: fix
dev: Carries prior blocking reasons into rebuilt merge and review prompts so a smaller residual diff cannot incorrectly finalize a task as done.
