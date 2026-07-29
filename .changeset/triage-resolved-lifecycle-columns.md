---
"@runfusion/fusion": patch
---

summary: Tasks on a workflow with renamed columns are now planned, and their specs land in that workflow's own column.
category: fix
dev: U7 / R3. `triage.ts` was in no Phase B unit's file list, so its lifecycle-column literals were unowned. Five converted to trait-resolved roles via `resolveTaskLifecycleColumns`: both halves of `discoverReadyPlanningTasks` (intake + hold, one IR cache per pass), `recoverApprovedTask`'s intake gate, and finalize's same-column skip plus its release-move target. Unresolvable workflow or no hold column now withholds the handoff (`outcome: "withheld"`) instead of falling back to a literal. Measured: genuine lifecycle-column sites in triage.ts 15 -> 10; the remaining 10 are listed in the PR with the reason each was left.
