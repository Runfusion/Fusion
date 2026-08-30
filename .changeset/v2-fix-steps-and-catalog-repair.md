---
"@runfusion/fusion": patch
---

summary: A failed final check or review now shows named fix steps on the card; per-step failures stay in their step.
category: fix
dev: Adds `fix-steps-from-failed-gates.test.ts`, driving the real `requestPreMergeOptionalStepFix` and `appendReviewRemediationSteps` against the real built-in registry and asserting on `task.steps`: a `verification` failure and a `code-review` REVISE each append pending named steps with remediation provenance, a review failure with no REVISE verdict appends nothing, no other node id can reach the appender (so a per-step test failure is fixed inside its step), and `builtin:coding-ideas` keeps reopen-trailing. Also repairs three leftovers from the V2 rework: the missing `builtin:coding-ideas-v2` entry in `builtin-workflows-lifecycle.test.ts` EXPECTATIONS (catalog-coverage assertion was red on main), the registry description and layout (ghost `verification`/`verification-remediation`/`completion-summary`/`post-merge-verification` keys removed, `documentation-delivery` repositioned after `code-review` so the editor diagram matches the graph), and the `implementation-only-leakage` audit, which no longer flags `testing|verification` now that the planner emits that step deliberately.
