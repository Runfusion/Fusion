---
"@runfusion/fusion": minor
---

summary: A task's Stats tab shows the collected turns of external agent sessions proven to be its own runs.
category: feature
dev: New `GET /external-sessions/by-task/:taskId`, backed by `ExternalSessionAttribution.sessionIdsForTask`, which reuses the F4 matcher and its refusals.
