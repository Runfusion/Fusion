import type { WorkflowIrNode } from "./workflow-ir-types.js";

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

Be specific: cite the plan section or file path for every finding and explain the concrete correction.

## Output Requirements
- APPROVE: the plan is ready for execution.
- APPROVE_WITH_NOTES: execution may proceed, but include non-blocking advisory notes.
- REVISE: the plan should be corrected before execution; include the missing or wrong requirement and the needed change.
- Final output: output exactly one trailing JSON object on the final line (no markdown fences, no surrounding prose):
{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}`;

/** Build the `plan-review` optional-group node placed between planning and execution. */
export function planReviewOptionalGroupNode(
  column: string,
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
    column,
    config: {
      name: PLAN_REVIEW_NAME,
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
