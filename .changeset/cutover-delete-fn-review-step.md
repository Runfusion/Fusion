---
"@runfusion/fusion": minor
---

summary: Review gates now run only as workflow nodes — the in-session step reviewer is gone.
category: internal
dev: U10/R9 of the IR-driven lifecycle cutover deletes the `fn_review_step` executor tool, its RETHINK git-reset/session-rewind path, the per-step conversation checkpoint map, the deferred reviewer provider-error re-raise channel, and the review-level prompt scaffolding that told the model to call it. Plan/code/browser review are owned exclusively by workflow graph nodes.
