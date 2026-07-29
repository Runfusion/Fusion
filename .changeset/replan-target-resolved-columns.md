---
"@runfusion/fusion": patch
---

summary: A rejected plan on a custom workflow is sent back to that workflow's own planning column, not a column it does not have.
category: fix
dev: U7 / R3, R7. `resolveReplanTargetColumn` preferred the literal `triage`, then `todo`, then returned `triage` by fiat — so any workflow declaring neither (builtin:marketing, any renamed set) had its Plan Review REVISE bounce moved into an undeclared column for `reconcileUndeclaredTaskColumns` to clean up. Legacy ids stay preferred first so both coding built-ins keep their exact current target; only a workflow declaring neither reaches the trait fallback, which prefers HOLD over intake (an intake column may be manual-capture with no AI, as in Coding (Ideas)). No declared column at all now returns undefined and every caller parks visibly instead of logging a move it did not make.
