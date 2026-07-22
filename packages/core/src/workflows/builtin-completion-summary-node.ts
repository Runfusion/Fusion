import type { WorkflowIrNode } from "./workflow-ir-types.js";

export const COMPLETION_SUMMARY_NODE_ID = "completion-summary";

/*
 * FNXC:WorkflowCompletion 2026-07-01-16:20:
 * Single source of truth for "is this the advisory completion-summary projection
 * node?". The engine, graph executor, and lifecycle validation all key summary
 * behavior off `summaryTarget: "task"` (built-in id `completion-summary`). This
 * node is BEST-EFFORT: `ensureWorkflowCompletionSummary` deterministically
 * backfills `task.summary` at the review/done boundary, and every built-in
 * workflow wires it with a success-only edge (no failure edge — see
 * `builtin-workflows.ts` `linear()` and the `*-workflow-ir.ts` graphs). So a
 * summary-node failure must never terminate or loop the graph (issue #1863).
 */
export function isCompletionSummaryNode(node: { id?: string; config?: Record<string, unknown> }): boolean {
  return node.config?.summaryTarget === "task" || node.id === COMPLETION_SUMMARY_NODE_ID;
}

const COMPLETION_SUMMARY_PROMPT = `Generate the final completion summary for this task.

Use the task description, executed workflow context, changed files/diff, verification notes, and any produced artifacts.

Output 2-4 concise sentences for the task card and downstream integrations:
- state what was completed,
- mention important files/artifacts or user-visible behavior when known,
- mention verification performed or why verification was not applicable,
- do not include markdown headings, bullet lists, verdict JSON, or process narration.`;

export function completionSummaryNode(column: string): WorkflowIrNode {
  return {
    id: COMPLETION_SUMMARY_NODE_ID,
    kind: "prompt",
    column,
    config: {
      /*
       * FNXC:WorkflowCompletion 2026-06-29-11:09:
       * Built-in workflows must generate a real agent-authored completion summary
       * as part of graph execution, not rely only on a recovery fallback after the
       * task reaches review/done. The engine treats `summaryTarget: "task"` as a
       * projection contract and persists this node's output to `task.summary`.
       */
      name: "Completion summary",
      prompt: COMPLETION_SUMMARY_PROMPT,
      toolMode: "readonly",
      summaryTarget: "task",
    },
  };
}
