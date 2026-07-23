---
"@runfusion/fusion": patch
---

summary: Stop the legacy-adoption sweep from clearing live task statuses (planning, queued, merging, stuck-killed) on store open.
category: fix
dev: LEGACY_STATUS_ADOPTION now preserves statuses with live post-cutover writers; only writer-less statuses (plan-review-unavailable, triaged) keep resume-graph. Generalizes the FN-8498 needs-replan fix after FN-8504's live planner status was cleared mid-session.
