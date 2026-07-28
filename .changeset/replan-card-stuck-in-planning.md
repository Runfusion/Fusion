---
"@runfusion/fusion": patch
---

summary: Cards sent back for re-planning by Plan Review now actually get re-planned instead of sitting in Planning.
category: fix
dev: `hasAdvancedPastPlanning` now lets the DURABLE replan parks (`needs-replan`, `plan-review-unavailable` — derived as `PLANNING_STAGE_STATUSES` minus the transient `planning`) outrank the sticky `firstExecutionAt`/`executionStartedAt` evidence added in the plan-worktree cutover, so triage discovery re-admits a rebounded card. `planning` deliberately still loses to the stamps: a stamp landing on a `planning` row means execution won the FN-8361 claim race. A triage card carrying a stamp with no planning status is still excluded for self-healing's advanced recovery (PR #2360).
