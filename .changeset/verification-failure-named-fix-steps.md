---
"@runfusion/fusion": patch
---

summary: A failing test or build now creates named fix steps instead of bouncing the task with nothing to do.
category: fix
dev: The FN-3345 deterministic verification gate (`run-implementation.ts`, runs `testCommand`/`buildCommand` after every planned step and before the in-review handoff) routed BOTH its bounces through `sendTaskBackForFix` regardless of the workflow's `stepReopenPolicy`. Under `none` — declared by `parse.implementationOnlySteps` + `preserveRemediationSteps`, selected today only by `builtin:coding-ideas-v2` — that call reopens nothing, so the card returned to implementation with zero pending steps, the foreach answered `already-expanded`, and it advanced to Code Review with the failing command unaddressed. The bounce shape now lives in `executor/bounce-verification-failure.ts`: `none` routes to `appendReviewRemediationSteps` (one named step per file in the failing output, PROMPT.md File Scope widened, executor re-dispatched, bounded at 3 waves then parked for a human), while `reopen-trailing` keeps its exact prior call. This revives the `Verification` branch of `appendReviewRemediationSteps`, which had been caller-less since the graph's `verification` node was removed. `builtin:coding` and `builtin:coding-ideas` are unaffected.
