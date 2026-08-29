---
"@runfusion/fusion": patch
---

summary: Task rows now show Verification and Documentation & Delivery progress while a card sits in review.
category: fix
dev: `ListView` resolved progress with `scope: "implementation"` unconditionally while `TaskCard` already switched to the full pipeline in the review lane, so review-column gates were invisible in list view and `shouldShowTaskProgress` suppressed the column entirely. Both now resolve the lane through `isReviewColumnRole` (trait-based, not the hardcoded `in-review` id). This matters for review-column workflows such as `builtin:coding-ideas-v2`, which promote Verification and Documentation & Delivery from hidden checklist entries into first-class review-lane gates.
