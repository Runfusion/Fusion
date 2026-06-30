import type { WorkflowIrNode } from "./workflow-ir-types.js";

export const COMPLETION_SUMMARY_NODE_ID = "completion-summary";

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
