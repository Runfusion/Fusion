---
"@runfusion/fusion": patch
---

summary: Task cards now show Verification, Documentation & Delivery and Code Review progress in review.
category: fix
dev: `TaskCard` resolved the full pipeline once a card reached its review lane but `showProgressSection` still gated rendering on `task.status === "executing" || isWipColumn`, so the breakdown it had just computed was suppressed. FN-7676 hid it in Planning because enumerated steps are a premature planning artifact there; that reasoning does not extend to in-review, where a review-column workflow runs those gates as real advancing work. Both the scope switch and the render gate now resolve the lane via `isReviewColumnRole` instead of the hardcoded `in-review` id.
