---
"@runfusion/fusion": patch
---

summary: Completing a task now releases its dependents on boards with renamed columns.
category: fix
dev: `reconcileCompletedTask` read the literal `todo`/`in-progress`/`in-review`, so on a renamed board it released nothing and every dependent stayed blocked on finished work. The three reads resolve via `resolveProjectColumnsForRoles`, and dependency satisfaction resolves per dependency (complete/review/archived roles, legacy ids unioned).
