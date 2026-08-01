---
"@runfusion/fusion": patch
---

summary: A stuck planner's approved plan is recovered again instead of being discarded and re-planned from scratch.
category: fix
dev: U11 (#2515) audit. Main now resolves the intake lane for recovery, which fixed merged/renamed workflows and silently broke cards still SITTING in the legacy `triage` column — the migration population U11 re-homing has not reached. `recoverApprovedTask` gated on `task.column !== "triage"`, so after the Planning merge it refused every default-workflow card and the approved spec was discarded — the stale-planning sweeps cleared the status and ordinary discovery re-planned the card, burning a fresh LLM pass on the exact path FN-1312 built to avoid that. Now accepts the task's resolved INTAKE column OR the legacy `triage` id: additive, so cards still awaiting U11 re-homing keep recovering too. Intake-only scope preserved, not widened.
