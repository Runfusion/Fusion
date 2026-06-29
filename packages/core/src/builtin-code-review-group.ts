import type { WorkflowIrNode } from "./workflow-ir-types.js";

/*
FNXC:CodeReviewStep 2026-06-25-15:00:
Code Review is a DEFAULT-ON but TOGGLEABLE step in the built-in coding and
stepwise-coding workflows: an `optional-group` container node with `defaultOn: true`.
It is part of the existing flows and runs for every coding task by default (the
default-on resolver seeds `code-review` into a new task's enabledWorkflowSteps), yet an
operator can turn it off per task by removing `code-review` from enabledWorkflowSteps —
when disabled the group passes through byte-inert, restoring the exact prior flow.

The group sits on the pre-merge success path (execute → [browser-verification optional]
→ code-review → review). The group node id `code-review` is the STABLE per-task enable
key; the inner template node carries a DISTINCT id (`code-review-step`) because a template
node id may not collide with the group/top-level node id (U1 validation).

The inner node mirrors the dashboard's `stepTemplateToNode` projection of the canonical
`code-review` step: a `prompt` node carrying the prompt, `toolMode` (readonly — review
reads the diff, never mutates), and `gateMode` (advisory — non-blocking, like the
existing review; operators can promote to a gate).

FNXC:CodeReviewStep 2026-06-25-00:00:
U6 deleted the built-in step-template catalog; the inner node's literal
name/description/prompt/toolMode/gateMode are now inlined here directly (byte-identical
to the former `code-review` catalog entry). These built-ins are the parity oracle, so
the produced node bytes must NOT change.
*/

/** Stable per-task enable key + group node id. */
export const CODE_REVIEW_GROUP_ID = "code-review";

/** Inner template node id — distinct from the group id (template-node-id collision rule, U1). */
export const CODE_REVIEW_STEP_NODE_ID = "code-review-step";

/** Display name (inlined from the former `code-review` catalog template). */
const CODE_REVIEW_NAME = "Code Review";

/** Short description (inlined from the former catalog template). */
const CODE_REVIEW_DESCRIPTION =
  "Diff-review the task's changes for correctness bugs, regressions, and intent mismatches that tests miss";

/** Agent prompt (inlined verbatim from the former catalog template — parity oracle). */
const CODE_REVIEW_PROMPT = `You are a senior code reviewer. Review the task's diff for the correctness value automated tests do NOT catch.

## Step 1: Read the change
1. Read the full diff against the base branch: \`git diff <base>...HEAD\` (or \`git diff <base>\`). Determine the base from the task context / merge target.
2. Read the changed files in full where the diff is non-trivial, so you see the surrounding code paths the change touches — not just the hunks.

## Step 2: Review focus (the value tests miss)
1. **Correctness / logic bugs** — wrong conditions, inverted boolean/comparison logic, off-by-one, incorrect operator precedence, mishandled return values.
2. **Broken edge cases** — empty/undefined/null inputs, zero/duplicate/boundary values, concurrency and ordering assumptions.
3. **Intent vs implementation** — does the code actually do what the task/PROMPT.md describes? Flag silent scope drift or partial implementations.
4. **Regressions in touched code paths** — does the change break or weaken an existing behavior in the files it edits or their callers?
5. **Error handling** — swallowed errors, unhandled rejections/exceptions, missing validation at trust boundaries, misleading error messages.
6. **Contract / signature changes** — changed function/exported-type signatures, API request/response shapes, or serialization that breaks existing callers.

Be specific: cite \`file:line\` for every finding and explain the concrete failure it causes.

## Output Requirements
- Fast-bail: if the diff is trivial, generated, or out-of-scope for code review (e.g. pure docs/config/formatting with no logic), output {"verdict":"APPROVE","notes":"out of scope: code review"} immediately and stop.
- APPROVE: no correctness concerns; use empty or brief notes.
- APPROVE_WITH_NOTES: shippable, but include non-blocking advisories (with file:line) in notes.
- REVISE: a correctness bug, regression, or contract break requires changes; include file:line and the concrete failure plus remediation in notes.
- Final output: output exactly one trailing JSON object on the final line (no markdown fences, no surrounding prose):
{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}`;

/**
 * Build the `code-review` optional-group node placed on a workflow's pre-merge path.
 * `defaultOn: true` makes it run by default while remaining togglable per task. `column`
 * matches where the browser-verification group sits (in-progress) so the editor renders
 * the group in the implementation column.
 *
 * Mirrors `stepTemplateToNode(code-review)`: a single `prompt` node whose config carries
 * the inlined prompt + `toolMode: "readonly"` + `gateMode: "advisory"`.
 */
export function codeReviewOptionalGroupNode(
  column: string,
  options: { defaultOn?: boolean } = {},
): WorkflowIrNode {
  return {
    id: CODE_REVIEW_GROUP_ID,
    kind: "optional-group",
    column,
    config: {
      name: CODE_REVIEW_NAME,
      // Default-ON: runs for every coding task by default, but operators can toggle it
      // off per task (remove `code-review` from enabledWorkflowSteps).
      defaultOn: options.defaultOn ?? true,
      template: {
        nodes: [
          {
            id: CODE_REVIEW_STEP_NODE_ID,
            kind: "prompt",
            config: {
              name: CODE_REVIEW_NAME,
              description: CODE_REVIEW_DESCRIPTION,
              prompt: CODE_REVIEW_PROMPT,
              toolMode: "readonly",
              gateMode: "advisory",
            },
          },
        ],
        edges: [],
      },
    },
  };
}
