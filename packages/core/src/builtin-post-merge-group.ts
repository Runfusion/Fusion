import type { WorkflowIrNode } from "./workflow-ir-types.js";

/*
FNXC:WorkflowPostMerge 2026-06-26-09:00:
Factory for a POST-MERGE optional-group node — the graph-native execution mechanism
for post-merge workflow steps (U7 spike). Mirrors `codeReviewOptionalGroupNode` /
`browserVerificationOptionalGroupNode`, but the produced node carries
`config.phase: "post-merge"` so the graph executor:
  1. runs it only AFTER a successful merge (when wired off the merge region and the
     `graphNativePostMerge` flag is on), and
  2. records its WorkflowStepResult with `phase: "post-merge"` + emits `[post-merge]`
     logs. Advisory post-merge failures are non-blocking; explicit gate-mode
     verification failures block final graph success after merge proof.

FNXC:WorkflowPostMerge 2026-06-29-12:22:
Full task built-ins need an explicit default-off post-merge verification node so
post-merge audit/verification policy can live in workflow definitions instead of
merger-only fallback code. The group node id is the STABLE per-task enable key
(`enabledWorkflowSteps`), and the inner template node carries a DISTINCT id
(`${id}-step`) — a template node id may not collide with the group/top-level node id
(optional-group validation).
*/

export const POST_MERGE_VERIFICATION_GROUP_ID = "post-merge-verification";

const POST_MERGE_VERIFICATION_PROMPT = `You are a post-merge verification reviewer. Verify that the task's merged result is safe after integration.

## Review focus
1. Confirm the task has merge proof or already-on-main proof before treating the workflow as complete.
2. Check the final merged diff and task summary for obvious mismatches, missing verification evidence, or integration-only regressions.
3. If configured test/build commands are available in the task context, inspect their latest result or explain why no post-merge command was applicable.

## Output Requirements
- APPROVE: post-merge verification is acceptable.
- APPROVE_WITH_NOTES: completion may proceed with non-blocking notes.
- REVISE: completion should be blocked; include the concrete post-merge issue and the needed follow-up.
- Final output: output exactly one trailing JSON object on the final line (no markdown fences, no surrounding prose):
{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}`;

export interface PostMergeOptionalGroupSpec {
  /** Stable per-task enable key + group node id. */
  id: string;
  /** Display name (toggle/editor surfaces + recorded `workflowStepName`). */
  name: string;
  /** Column the group node sits in (typically a post-merge/`done` column). */
  column: string;
  /** Agent prompt for the inner post-merge step. */
  prompt: string;
  /** Optional short description for the inner node. */
  description?: string;
  /** Inner step tool access; defaults to "readonly". */
  toolMode?: "readonly" | "coding";
  /** Gate semantics; defaults to "advisory" (post-merge failures are non-blocking). */
  gateMode?: "advisory" | "gate";
  /** Seed the per-task enable toggle for new tasks; defaults to false (opt-in). */
  defaultOn?: boolean;
}

/**
 * Build a post-merge `optional-group` node. The node config is marked
 * `phase: "post-merge"` so the graph executor's optional-group recording path keys
 * the result phase + log prefix off it.
 */
export function postMergeOptionalGroupNode(spec: PostMergeOptionalGroupSpec): WorkflowIrNode {
  return {
    id: spec.id,
    kind: "optional-group",
    column: spec.column,
    config: {
      name: spec.name,
      phase: "post-merge",
      defaultOn: spec.defaultOn ?? false,
      template: {
        nodes: [
          {
            id: `${spec.id}-step`,
            kind: "prompt",
            config: {
              name: spec.name,
              ...(spec.description !== undefined ? { description: spec.description } : {}),
              prompt: spec.prompt,
              toolMode: spec.toolMode ?? "readonly",
              gateMode: spec.gateMode ?? "advisory",
            },
          },
        ],
        edges: [],
      },
    },
  };
}

export function postMergeVerificationOptionalGroupNode(column = "done"): WorkflowIrNode {
  return postMergeOptionalGroupNode({
    id: POST_MERGE_VERIFICATION_GROUP_ID,
    name: "Post-merge verification",
    column,
    prompt: POST_MERGE_VERIFICATION_PROMPT,
    description: "Verify the integrated result after merge proof before final completion",
    gateMode: "gate",
    defaultOn: false,
  });
}
