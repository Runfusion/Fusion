import type { WorkflowIr, WorkflowIrColumn, WorkflowIrV2 } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import { BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR } from "./builtin-stepwise-final-review-coding-workflow-ir.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";

/*
FNXC:CodingIdeasWorkflow 2026-07-04-09:15:
Operators need a manual-capture intake ("Ideas") in front of the default coding pipeline so they can park tasks without the engine auto-planning them. This workflow clones the current default Coding graph (stepwise execution + final review) and swaps the board columns to a five-stage Ideas → Todo → In-progress → In-review → Done shape.

FNXC:CodingIdeasWorkflow 2026-07-04-09:18:
The "Ideas" column is the intake column with autoTriage disabled. Tasks created into this workflow land there and are NOT picked up by the triage service until an operator moves them to "Todo" (the merged planner + capacity column). Planning then runs in place inside "Todo"; a "ready" badge distinguishes planned (real PROMPT.md) tasks from unplanned (bootstrap stub) ones while they wait for an in-progress slot. See createTask intake-column wiring (store.ts) and the triage todo-discovery extension (triage.ts).
*/

/** The board columns for the Coding (Ideas) workflow. The "ideas" intake carries
 *  `autoTriage: false` so the engine's createTask intake-column wiring lands new
 *  cards there and the triage service leaves them alone until they are promoted
 *  into "todo". "todo" merges the legacy triage (planner) and todo (capacity
 *  hold) stages into one agent-staffed column. */
const CODING_IDEAS_COLUMNS: WorkflowIrColumn[] = [
  {
    id: "ideas",
    name: "Ideas",
    traits: [{ trait: "intake", config: { autoTriage: false } }],
  },
  {
    id: "todo",
    name: "Todo",
    traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }],
  },
  {
    id: "in-progress",
    name: "In progress",
    traits: [
      { trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } },
      { trait: "abort-on-exit" },
      { trait: "timing" },
    ],
  },
  {
    id: "in-review",
    name: "In review",
    traits: [{ trait: "merge-blocker" }, { trait: "human-review" }, { trait: "stall-detection" }, { trait: "merge" }],
  },
  { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  { id: "archived", name: "Archived", traits: [{ trait: "archived" }] },
];

/** Planning-stage node ids that sit in the legacy "triage" / "in-progress"
 *  columns in the cloned default graph. They are re-homed to the merged "todo"
 *  planner column so an agent is visibly working while the spec is produced. */
const PLANNING_NODE_IDS: Record<string, true> = {
  plan: true,
  "plan-review": true,
  "plan-replan": true,
};

const RAW_BUILTIN_CODING_IDEAS_WORKFLOW_IR: WorkflowIr = (() => {
  const ir = JSON.parse(JSON.stringify(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR)) as WorkflowIr;
  ir.name = "builtin-coding-ideas";

  const v2 = ir as WorkflowIrV2;
  v2.columns = CODING_IDEAS_COLUMNS.map((column) => ({
    ...column,
    traits: column.traits.map((trait) => ({
      ...trait,
      config: trait.config ? { ...trait.config } : undefined,
    })),
  }));

  /*
  FNXC:CodingIdeasWorkflow 2026-07-04-09:30:
  Re-home graph nodes to the new column shape: the start node becomes the "ideas" intake anchor; planning-stage nodes move to the merged "todo" column; every execution / review / merge / done node keeps its existing column id (in-progress / in-review / done), which still exists in the new column set. Unknown legacy columns (e.g. a leftover "triage" placement) default to "todo" so no node is ever left dangling in a column the workflow no longer declares.
  */
  const knownColumnIds = new Set(v2.columns.map((c) => c.id));
  for (const node of v2.nodes) {
    if (node.kind === "start") {
      node.column = "ideas";
      continue;
    }
    if (PLANNING_NODE_IDS[node.id]) {
      node.column = "todo";
      continue;
    }
    if (node.id === "code-review" || node.id === "completion-summary" || node.id.startsWith("merge-")) {
      node.column = "in-review";
      continue;
    }
    if (node.id === "code-review-remediation") {
      node.column = "in-progress";
      continue;
    }
    if (!node.column || !knownColumnIds.has(node.column)) {
      node.column = "todo";
    }
  }

  // FNXC:CodingIdeasWorkflow 2026-07-21-12:20:
  // Keep this preset intentionally small: planning + plan review in Todo,
  // implementation in In progress, then code review and merge in In review.
  // Browser and post-merge verification remain available in richer workflows;
  // direct success edges replace the removed nodes so the reduced preset keeps
  // one continuous executable path.
  const removedNodeIds = new Set([
    "browser-verification",
    "browser-verification-remediation",
    "post-merge-verification",
  ]);
  v2.nodes = v2.nodes.filter((node) => !removedNodeIds.has(node.id));
  v2.edges = v2.edges.filter((edge) => !removedNodeIds.has(edge.from) && !removedNodeIds.has(edge.to));
  if (!v2.edges.some((edge) => edge.from === "steps" && edge.to === "code-review")) {
    v2.edges.push({ from: "steps", to: "code-review", condition: "success" });
  }
  if (!v2.edges.some((edge) => edge.from === "merge-attempt" && edge.to === "end" && edge.condition === "success")) {
    v2.edges.push({ from: "merge-attempt", to: "end", condition: "success" });
  }

  v2.settings = BUILTIN_WORKFLOW_SETTINGS;
  return ir;
})();

export const BUILTIN_CODING_IDEAS_WORKFLOW_IR = parseWorkflowIr(RAW_BUILTIN_CODING_IDEAS_WORKFLOW_IR);
