---
"@runfusion/fusion": patch
---

summary: A task waiting in Planning with leftover steps is checked for a stale spec again instead of being skipped.
category: fix
dev: U11 (#2515) audit of U7's assigned site. `shouldSkipSpecStalenessForPreservedProgress` exempted cards with leftover progress from staleness evaluation unless they were in `triage` or carried a planning-stage status. With `triage` gone from the default lineage that clause stopped matching, so a card in the merged Planning column with steps from a previous pass and a cleared status took the exemption and was never checked — the scheduler's stale-spec rebound never fired and the card could dispatch against a superseded spec. The lane is now injected (the function is pure and sync, called inside a scheduler filter) and defaults to the legacy id, so unwired callers are byte-identical; both real callers resolve and pass the task's own intake column.
