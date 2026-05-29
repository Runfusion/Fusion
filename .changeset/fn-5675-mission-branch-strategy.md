---
"@runfusion/fusion": minor
---

Add mission-level branch strategy defaults so missions can persist whether triaged tasks should use project default branching, a shared existing/custom branch, or per-task derived branches.

Mission create/edit flows now save both `baseBranch` and `branchStrategy`, and mission triage handlers apply that stored strategy by default (including autopilot triage when no explicit branch options are supplied).

Also fix planning breakdown task creation to forward the selected branch options so multi-task planning respects the same branch selection used by single-task planning.
