import type { WorkflowIr, WorkflowIrV2 } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import { BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR } from "./builtin-stepwise-final-review-coding-workflow-ir.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";

/*
FNXC:WorkflowBrainstorming 2026-07-05-00:00:
FN-7584 closes the loop FN-7579 opened: `ask-user` and `exit-gate` node kinds
existed only as a documented composition (docs/workflow-steps.md, "Brainstorming
/ chat reach-out composition"), not a discoverable built-in. This module clones
the default Coding graph (BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR,
the same IR backing `builtin:coding`) and prepends a bounded brainstorming phase
between `start` and `plan`:

  start -> brainstorm-ask (ask-user: "what do you want to brainstorm?")
        -> brainstorm-refine (prompt, seam:"planning": turn the conversation
           so far into a refined brief)
        -> brainstorm-exit (exit-gate: condition on the ask-user's answer
           containing an approval phrase)
             outcome:exit     -> plan (rejoins the unmodified coding spine)
             outcome:continue -> brainstorm-ask (rework edge; the ask-user node
                                 carries config.reworkRegion:true so this is a
                                 legal top-level rework-region head per the U6
                                 convention validateWorkflowIr enforces)

The reused coding spine (parse-steps/foreach/step-review, optional
browser-verification/code-review groups, completion-summary,
post-merge-verification, and the full merge-primitive region) is left byte-for-byte
identical to `builtin:coding`'s graph, so every parity invariant that graph
already satisfies carries over unchanged; only the three new brainstorm nodes
and their four edges are new surface for the parity suite to cover.
*/

const APPROVAL_PHRASE = "looks good";

const RAW_BUILTIN_BRAINSTORMING_WORKFLOW_IR: WorkflowIr = (() => {
  const ir = JSON.parse(JSON.stringify(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR)) as WorkflowIrV2;
  ir.name = "builtin-brainstorming";

  // Insert the three brainstorm nodes right after `start` (order is cosmetic —
  // edges determine the walk — but keeping them near `start` mirrors the
  // reading order of the graph).
  const startIndex = ir.nodes.findIndex((node) => node.id === "start");
  if (startIndex < 0) {
    throw new Error("brainstorming built-in requires the cloned graph's start node");
  }
  const startColumn = ir.nodes[startIndex]!.column;
  const planNode = ir.nodes.find((node) => node.id === "plan");
  const brainstormColumn = planNode?.column ?? startColumn;

  ir.nodes.splice(
    startIndex + 1,
    0,
    {
      id: "brainstorm-ask",
      kind: "ask-user",
      column: brainstormColumn,
      config: {
        question:
          `What would you like to brainstorm? Share your idea and any constraints; reply "${APPROVAL_PHRASE}" once you're ready to move into planning.`,
        // FNXC:WorkflowBrainstorming 2026-07-05-00:00: top-level rework-region
        // head (U6 convention) — the loop bound the exit-gate's rework edge
        // resets to when it targets this node.
        reworkRegion: true,
        maxReworkCycles: 5,
      },
    },
    {
      id: "brainstorm-refine",
      kind: "prompt",
      column: brainstormColumn,
      config: {
        seam: "planning",
        name: "Refine brainstorm",
        prompt:
          "You are helping the user brainstorm before this task is planned. Read the task description and the user's latest reply. Turn the conversation so far into a short, structured refined brief: 1) the core idea/goal, 2) key constraints or requirements mentioned so far, 3) open questions still unresolved, 4) a one-line readiness assessment (ready to plan, or what's still missing). Keep it concise — this is a running scratchpad the user reviews each turn, not a final spec.",
      },
    },
    {
      id: "brainstorm-exit",
      kind: "exit-gate",
      column: brainstormColumn,
      config: {
        condition: { type: "output-contains", nodeId: "brainstorm-ask", value: APPROVAL_PHRASE },
      },
    },
  );

  // Rewire start -> plan through the new brainstorm loop.
  ir.edges = ir.edges.filter((edge) => !(edge.from === "start" && edge.to === "plan"));
  ir.edges.unshift(
    { from: "start", to: "brainstorm-ask", condition: "success" },
    { from: "brainstorm-ask", to: "brainstorm-refine", condition: "success" },
    { from: "brainstorm-refine", to: "brainstorm-exit", condition: "success" },
    { from: "brainstorm-exit", to: "plan", condition: "outcome:exit" },
    { from: "brainstorm-exit", to: "brainstorm-ask", condition: "outcome:continue", kind: "rework" },
  );

  ir.settings = BUILTIN_WORKFLOW_SETTINGS;
  return ir;
})();

export const BUILTIN_BRAINSTORMING_WORKFLOW_IR = parseWorkflowIr(RAW_BUILTIN_BRAINSTORMING_WORKFLOW_IR);
