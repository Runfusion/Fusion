---
"@runfusion/fusion": minor
---

summary: Unify max concurrency across planning/execution/review and simplify board capacity indicators.
category: feature
dev: maxConcurrent caps all top-level working agents per project; maxTriageConcurrent removed from UI (Settings, Command Center, Engine Control) and admission; free slots admit oldest createdAt via per-project atomic admission coordinator across lanes; footer Waiting/Running/Blocked; column headers show executing/total via shared Running predicate; Running counts unpaused WIP membership (sessionFile is not a DB/board field — do not require it); nested runNested helpers remain parent-internal soft-breach by design.
