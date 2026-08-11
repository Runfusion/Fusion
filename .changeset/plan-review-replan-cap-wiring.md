---
"@runfusion/fusion": patch
---

summary: The Plan Review replan cap setting now actually works; lowering it takes effect.
category: fix
dev: `planReviewReplanCap` was declared, validated, documented and editable in the Workflow Editor but read by nothing — the unbounded-default backstop was hardcoded to `PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT`, a bound on how much reviewer prose is replayed into the next planning prompt, so two unrelated concerns shared one number and trimming prompt history would have silently tightened a safety ceiling. `requestPreMergeOptionalStepFix` now resolves the backstop from the setting, defaulting to the new `DEFAULT_PLAN_REVIEW_REPLAN_CAP` (15, the previously-effective value, so this is a pure re-wiring); `0` parks on the first REVISE. An explicit `planReviewMaxRevisions` / node `maxRevisions` budget remains a stricter, earlier gate. Also deletes the dead `PLAN_REVIEW_GATE_REPLAN_CAP` constant (an unread ceiling belonging to the U10-deleted triage gate) and ratchets it in `legacy-tombstones.test.ts`; `Task.planReviewReplanCount` is documented as legacy/never-written, with the live owner named.
