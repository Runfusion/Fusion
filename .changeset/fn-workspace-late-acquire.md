---
"@runfusion/fusion": minor
---

summary: Let an executor add a repository during review when nothing has landed, at the cost of a re-review.
category: feature
dev: Splits the workspace late-acquire gate into two tiers. Tier 2 (any landedSha, a merging*/workspace-review-required status, or a merge pending/active via the threaded merge-pipeline provider) stays refused. Tier 1 admits an explicit review column when the task is review-evidenced and a Code Review node is reachable, then records the scope extension, emits `task:workspace-scope-extended-post-review`, and seeds Code Review re-entry — strictly after a successful acquire, never unwinding it on reroute failure.
