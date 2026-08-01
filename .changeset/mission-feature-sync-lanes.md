---
"@runfusion/fusion": patch
---

summary: A mission roadmap keeps tracking its tasks on workflows with renamed columns instead of silently freezing.
category: fix
dev: U7 / R3 — unowned drift site (mission-feature-sync.ts is in no unit's file list). `reconcileMissionFeatureState` read five column literals (done, archived, in-progress, in-review, triage/todo); on a renamed workflow every branch answered "no" and the function collapsed to a permanent noop, so the roadmap froze while the tasks underneath ran to completion. Now resolves complete/archived/wip/review/intake/hold from the task's own workflow. Unresolvable workflow falls back to the legacy ids, NOT to noop — going silent is the failure being fixed. The planner-lane branch also accepts an orphaned legacy `triage`/`todo` id (pre-U11 rows awaiting re-homing), scoped to ids the workflow does not declare so a custom workflow naming its review lane `triage` is not walked backwards.
