---
"@runfusion/fusion": minor
---

summary: Keep resolved review findings visible without allowing no-op revision requests.
category: feature
dev: Adds WorkflowReviewFinding.resolution and prompt/script supersededFindingIds claims persisted at the result sink; resolved findings bypass gate/remediation actions and POST /tasks/:id/review/address rejects them.
