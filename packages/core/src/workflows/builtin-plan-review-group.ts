import type { WorkflowIrNode } from "./workflow-ir-types.js";
import { PLAN_REVIEW_COMPLETENESS_POLICY } from "../agents/planning-review-policy.js";
import { REVIEW_REREVIEW_POLICY, REVIEW_SEVERITY_POLICY } from "../agents/review-severity-policy.js";

/*
FNXC:PlanReviewStep 2026-06-28-23:29:
The default Coding workflow needs an optional plan review before a task crosses from planning into execution. Model it as a DEFAULT-ON `optional-group` so operators get the same per-task toggle semantics as Code Review: enabled tasks review PROMPT.md before `parse-steps`, and disabled tasks pass through directly to execution.
*/

/** Stable per-task enable key + group node id. */
export const PLAN_REVIEW_GROUP_ID = "plan-review";

/** Inner template node id — distinct from the group id (template-node-id collision rule, U1). */
export const PLAN_REVIEW_STEP_NODE_ID = "plan-review-step";

const PLAN_REVIEW_NAME = "Plan Review";

const PLAN_REVIEW_DESCRIPTION =
  "Review the task plan before execution for missing requirements, unsafe scope, and unclear implementation steps";

const PLAN_REVIEW_PROMPT = `You are a senior plan reviewer. Review the task's PROMPT.md before implementation starts.

## Step 1: Read the plan
1. Read PROMPT.md and any task context the plan cites.
2. Confirm the plan captures the user's current requirements, expected workflow, file scope, and verification path.

## Review focus
1. **Requirement coverage** — missing user requirements, changed requirements, acceptance criteria, or workflow constraints.
2. **Execution clarity** — vague steps, missing ordering/dependencies, or steps that cannot be executed by the coding agent.
3. **Scope control** — unsafe expansion, missing file-scope boundaries, or contradictions with project instructions.
4. **Verification quality** — absent or weak tests/checks for the behavior being changed.
5. **Risk callouts** — migrations, data-loss paths, external integrations, secrets, or plugin/runtime dependencies that need explicit handling.

${PLAN_REVIEW_COMPLETENESS_POLICY}

${REVIEW_SEVERITY_POLICY}

${REVIEW_REREVIEW_POLICY}

Be specific: cite the plan section or file path for every finding and explain the concrete correction.

## Output Requirements
- APPROVE: the plan is ready for execution.
- APPROVE_WITH_NOTES: execution may proceed. Use this when your findings are all P2 — they are recorded and handed to the implementer without another planning round.
- REVISE: the plan must be corrected before execution. Requires at least one \`critical\` or \`high\` finding in \`findings\`; a REVISE whose findings are all P2 will be treated as APPROVE_WITH_NOTES.
- CLOSE_NO_OP: implementation must not proceed because the premise is stale, the work is already satisfied, redundant, or a duplicate. The notes field MUST begin with exactly one existing completion sentinel: PREMISE STALE:, NO-OP:, NOOP:, REDUNDANT:, or DUPLICATE:. For duplicates, use DUPLICATE: FN-NNNN ... when the canonical task is known.
- Every blocking issue MUST appear as an entry in \`findings\` with its severity. Prose in \`notes\` alone does not block, and is not a durable input to the next planning round.
- Final output: output exactly one trailing JSON object on the final line (no markdown fences, no surrounding prose):
{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE|CLOSE_NO_OP","notes":"...","findings":[{"id":"stable-id","title":"concise issue","body":"actionable correction","severity":"critical|high|medium|low","resolution":"open|resolved-in-review|superseded"}]}`;

/*
FNXC:PlanReviewStep 2026-07-27-06:10:
Plan Review is a PLANNING-lane gate and runs in the column the card actually rests in after
specification: `todo`. Not `triage` — that is the intake lane, and an intake column has no releaser
(the capacity sweep only releases from a `hold` column), so a card parked there waits for a human.
Two reasons the column is load-bearing rather than cosmetic: the plan-in-place chain only seeds a
plan-review continuation when the node's column EQUALS the card's column
(`seedPreReleasePlanReviewContinuation`), and a card whose plan is still under review must not hold
a wip slot.

`column` is optional: linear built-ins (`builtin-workflows.ts`) resolve node columns by inheritance,
so those call sites omit it and `assignLinearNodeColumns` places the group in whatever planning
column the preceding node established — `todo` in practice, the same lane by a different route.
*/
/** Build the `plan-review` optional-group node placed between planning and execution. */
export function planReviewOptionalGroupNode(
  column?: string,
  options: { defaultOn?: boolean; maxRevisions?: number | "unbounded"; requireExternalIntegrationEvidence?: boolean } = {},
): WorkflowIrNode {
  const promptConfig: Record<string, unknown> = {
    name: PLAN_REVIEW_NAME,
    description: PLAN_REVIEW_DESCRIPTION,
    prompt: PLAN_REVIEW_PROMPT,
    toolMode: "readonly",
    gateMode: "gate",
  };
  if (options.requireExternalIntegrationEvidence === true) {
    /*
     * FNXC:PlanValidation 2026-06-30-08:56:
     * Only Coding (per-step review) keeps deterministic external-integration evidence as part of Plan Review. Default Coding must not inherit this pre-review blocker; graph execution reads this flag from the Plan Review template node and turns missing evidence into a REVISE outcome.
     */
    promptConfig.requireExternalIntegrationEvidence = true;
  }

  return {
    id: PLAN_REVIEW_GROUP_ID,
    kind: "optional-group",
    ...(column ? { column } : {}),
    config: {
      name: PLAN_REVIEW_NAME,
      reviewKind: "plan",
      defaultOn: options.defaultOn ?? true,
      /*
       * FNXC:WorkflowRemediation 2026-06-29-12:14:
       * Plan Review REVISE must loop through graph-owned replan and then return to Plan Review before execution. Mark the optional group as the bounded rework-region head so the top-level remediation edge is legal and cannot spin forever.
       */
      reworkRegion: true,
      maxReworkCycles: 3,
      /*
       * FNXC:WorkflowRevisionBudget 2026-06-30-19:49:
       * Built-in Plan Review/spec remediation is unbounded by default; workflow setting value `planReviewMaxRevisions` is the operator cap for read-only built-ins, while authored `maxRevisions` still lets custom/duplicated workflows encode their own budget.
       */
      maxRevisions: options.maxRevisions ?? "unbounded",
      template: {
        nodes: [
          {
            id: PLAN_REVIEW_STEP_NODE_ID,
            kind: "prompt",
            config: promptConfig,
          },
        ],
        edges: [],
      },
    },
  };
}
