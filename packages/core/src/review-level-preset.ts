/*
FNXC:ReviewLevelPreset 2026-07-19-10:00 (U8 / R6 / KTD-11):
`reviewLevel` is a CREATION-TIME preset over `enabledWorkflowSteps`, not a runtime
signal. At task creation, when the caller did NOT provide an explicit
`enabledWorkflowSteps`, the numeric level maps to the optional-group ids to enable:

  0 → (none)
  1 → code-review
  2 → plan-review + code-review
  3 → plan-review + browser-verification + code-review

The derived ids flow through the SAME optional-group id pass-through the creation
paths already use (`resolveEnabledWorkflowSteps` + `optionalGroupIdSet`, KTD-11), so
a preset id that collides with a legacy `WORKFLOW_STEP_TEMPLATES` entry stays
identity-stable through store create + update. An explicit `enabledWorkflowSteps`
(including an explicit empty `[]` opt-out) ALWAYS wins — the preset never overrides
operator intent. Post-creation `reviewLevel` mutation is a no-op (create-only).
*/

import { PLAN_REVIEW_GROUP_ID } from "./builtin-plan-review-group.js";
import { CODE_REVIEW_GROUP_ID } from "./builtin-code-review-group.js";
import { BROWSER_VERIFICATION_GROUP_ID } from "./builtin-browser-verification-group.js";

/**
 * Map a numeric review level to the optional-group ids it enables. Unknown /
 * out-of-range levels map to the empty set (no optional groups) so a stray value
 * can never silently enable a gate.
 */
export function resolveReviewLevelSteps(level: number): string[] {
  switch (level) {
    case 1:
      return [CODE_REVIEW_GROUP_ID];
    case 2:
      return [PLAN_REVIEW_GROUP_ID, CODE_REVIEW_GROUP_ID];
    case 3:
      return [PLAN_REVIEW_GROUP_ID, BROWSER_VERIFICATION_GROUP_ID, CODE_REVIEW_GROUP_ID];
    case 0:
    default:
      return [];
  }
}

/**
 * Normalize a task-create input by applying the reviewLevel preset to
 * `enabledWorkflowSteps` when — and only when — the caller left
 * `enabledWorkflowSteps` unset and provided a numeric `reviewLevel`. Returns the
 * input unchanged when an explicit `enabledWorkflowSteps` is present (explicit
 * wins, including an explicit empty array) or no `reviewLevel` is set. Never
 * mutates the argument.
 */
export function applyReviewLevelPreset<
  T extends { reviewLevel?: number; enabledWorkflowSteps?: string[] },
>(input: T): T {
  if (input.enabledWorkflowSteps !== undefined) return input; // explicit wins
  if (typeof input.reviewLevel !== "number") return input;
  return { ...input, enabledWorkflowSteps: resolveReviewLevelSteps(input.reviewLevel) };
}
