---
"@runfusion/fusion": patch
---

summary: Stop triage Plan Review from looping to the replan cap by converging the spec reviewer.
category: fix
dev: reviewStep/buildReviewRequest now thread the reviewer's own prior Plan Review feedback plus the replan attempt (spec gate only); at attempt 3+ the reviewer gates on critical issues only. Reviewer and planner prompts add spec-altitude, prior-issue-verification, front-loaded surface enumeration, and Postgres-only storage ground-truth rules.
