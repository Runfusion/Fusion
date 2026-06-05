import type { WorkflowIr } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";

/**
 * The built-in default workflow as a v2 IR. Its six columns have ids that are
 * EXACTLY the legacy enum values in legacy order (KTD-1), so a task with no
 * workflow selection resolves here and its stored `column` value is already a
 * valid column id — migration rewrites zero task rows.
 *
 * Trait ids are plain strings (the trait registry ships in U2); the mapping
 * reproduces legacy behavior verbatim (R12):
 *   triage      = intake
 *   todo        = hold(capacity) + reset-on-entry
 *   in-progress = wip + abort-on-exit + timing
 *   in-review   = merge-blocker + stall-detection + merge
 *   done        = complete
 *   archived    = archived
 *
 * The seam nodes (execute/review/merge) are placed in their columns; the graph
 * walk (edges) is byte-identical to the prior v1 coding pipeline, so the graph
 * executor continues to drive execute → review → merge unchanged.
 */
const RAW_BUILTIN_CODING_WORKFLOW_IR: WorkflowIr = {
  version: "v2",
  name: "builtin-coding-workflow",
  columns: [
    { id: "triage", name: "Triage", traits: [{ trait: "intake" }] },
    {
      id: "todo",
      name: "Todo",
      traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }],
    },
    {
      id: "in-progress",
      name: "In progress",
      traits: [{ trait: "wip" }, { trait: "abort-on-exit" }, { trait: "timing" }],
    },
    {
      id: "in-review",
      name: "In review",
      traits: [{ trait: "merge-blocker" }, { trait: "stall-detection" }, { trait: "merge" }],
    },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    { id: "archived", name: "Archived", traits: [{ trait: "archived" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "triage" },
    { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
    { id: "review", kind: "prompt", column: "in-review", config: { seam: "review" } },
    { id: "merge", kind: "prompt", column: "in-review", config: { seam: "merge" } },
    { id: "end", kind: "end", column: "done" },
  ],
  edges: [
    { from: "start", to: "execute" },
    { from: "execute", to: "review", condition: "success" },
    { from: "review", to: "merge", condition: "success" },
    { from: "merge", to: "end", condition: "success" },
    { from: "execute", to: "end", condition: "failure" },
    { from: "review", to: "end", condition: "failure" },
    { from: "merge", to: "end", condition: "failure" },
  ],
};

export const BUILTIN_CODING_WORKFLOW_IR = parseWorkflowIr(RAW_BUILTIN_CODING_WORKFLOW_IR);
