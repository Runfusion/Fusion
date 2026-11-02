---
"@runfusion/fusion": patch
---

summary: Cards queued behind a full work-in-progress lane are no longer skipped forever; the queue now actually rotates.
category: fix
dev: A shared-capacity refusal now stamps every row the pass examined instead of only the first, and the refusal horizon covers a full rotation of the due batch (`WORKFLOW_CONTINUATION_POLL_MS` is now named so the relationship is assertable). Measure first: 269 due continuations in one project, 14 with any `retryAfter`, one card ranked 98th behind a 20-row window.
