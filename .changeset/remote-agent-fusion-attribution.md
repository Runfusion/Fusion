---
"@runfusion/fusion": minor
---

summary: Remote agent sessions now show when they are a Fusion task run, so their cost is not counted twice.
category: feature
dev: Completes F4=1. `ExternalSessionAttribution` matches (provider → CLI adapter, native session id) against `cli_sessions.owner_project_id`-scoped rows; a null native id, an unmapped provider, or two claimants on one id all resolve to unattributed rather than a guess. No path-based backfill.
