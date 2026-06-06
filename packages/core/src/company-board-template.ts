/**
 * Company-model board column template (U3, R1/R2/R5/R6).
 *
 * The opinionated default workflow for a flag-on company board. It is a v2 IR
 * preset built over the SAME trait registry as the legacy default workflow, so
 * R6 (non-coding boards reach done with no merge machinery) falls out of column
 * config rather than new engine code.
 *
 * Differences from {@link BUILTIN_CODING_WORKFLOW_IR}:
 *  - NO `triage` column — the Lead absorbs triage's spec work on Todo entry
 *    (U5), so the company board's entry column is `todo` directly.
 *  - The three role columns (todo / in-progress / in-review) carry company-model
 *    markers: `role` ("lead" | "executor" | "reviewer") and `locked: true`.
 *    These markers are the carrier the placement/movement rules key off
 *    (workflow-reconciliation, workflow-transitions): a board whose IR carries
 *    them is a company-model board; one that doesn't stays on the legacy path.
 *    Legacy/default workflows never set them, so flag-off behavior is byte-
 *    identical.
 *
 * Two variants:
 *  - {@link COMPANY_BOARD_TEMPLATE_IR} (coding): the in-review column keeps the
 *    full merge machinery (merge-blocker + stall-detection + merge), mirroring
 *    legacy semantics so a coding board still gates done on a clean merge.
 *  - {@link COMPANY_BOARD_TEMPLATE_NON_CODING_IR} (non-coding): the in-review
 *    column OMITS the merge-blocker and merge traits (keeps stall-detection), so
 *    a task flows in-review → done with NO merge-queue interaction (R6, AE2).
 *
 * Trait mapping mirrors the legacy semantics for the columns that exist:
 *   todo        = hold(capacity) + reset-on-entry
 *   in-progress = wip + abort-on-exit + timing
 *   in-review   = merge-blocker + stall-detection + merge   (coding)
 *               = stall-detection                            (non-coding)
 *   done        = complete
 *   archived    = archived
 *
 * The graph (nodes/edges) reuses the coding pipeline's execute → review → merge
 * walk for the coding variant; the non-coding variant drops the `merge` node (no
 * merge step) so the walk is execute → review → end.
 */

import type { WorkflowIr, WorkflowIrColumn } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";

/** The company board's column ids in board order (no triage). Custom columns
 *  may be inserted between todo and in-review, and after in-review before done
 *  (R2) — never before todo. */
export const COMPANY_BOARD_COLUMN_IDS = [
  "todo",
  "in-progress",
  "in-review",
  "done",
  "archived",
] as const;

/** The three locked role columns, in board order (R1). */
const ROLE_COLUMNS: WorkflowIrColumn[] = [
  {
    id: "todo",
    name: "Todo",
    role: "lead",
    locked: true,
    traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }],
  },
  {
    id: "in-progress",
    name: "In progress",
    role: "executor",
    locked: true,
    traits: [{ trait: "wip" }, { trait: "abort-on-exit" }, { trait: "timing" }],
  },
];

/** The non-role columns shared by both variants. */
const TAIL_COLUMNS: WorkflowIrColumn[] = [
  { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  { id: "archived", name: "Archived", traits: [{ trait: "archived" }] },
];

/** The Reviewer's in-review column for the CODING variant: full merge machinery,
 *  mirroring legacy semantics. */
const IN_REVIEW_CODING: WorkflowIrColumn = {
  id: "in-review",
  name: "In review",
  role: "reviewer",
  locked: true,
  traits: [{ trait: "merge-blocker" }, { trait: "stall-detection" }, { trait: "merge" }],
};

/** The Reviewer's in-review column for the NON-CODING variant: no merge-blocker,
 *  no merge — the Reviewer's verdict still gates the exit, but there is no branch
 *  or merge step, so a task reaches done with no merge-queue interaction (R6). */
const IN_REVIEW_NON_CODING: WorkflowIrColumn = {
  id: "in-review",
  name: "In review",
  role: "reviewer",
  locked: true,
  traits: [{ trait: "stall-detection" }],
};

const RAW_COMPANY_BOARD_TEMPLATE_IR: WorkflowIr = {
  version: "v2",
  name: "company-board-template",
  columns: [...ROLE_COLUMNS, IN_REVIEW_CODING, ...TAIL_COLUMNS],
  nodes: [
    { id: "start", kind: "start", column: "todo" },
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
  settings: BUILTIN_WORKFLOW_SETTINGS,
};

const RAW_COMPANY_BOARD_TEMPLATE_NON_CODING_IR: WorkflowIr = {
  version: "v2",
  name: "company-board-template-non-coding",
  columns: [...ROLE_COLUMNS, IN_REVIEW_NON_CODING, ...TAIL_COLUMNS],
  nodes: [
    { id: "start", kind: "start", column: "todo" },
    { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
    { id: "review", kind: "prompt", column: "in-review", config: { seam: "review" } },
    { id: "end", kind: "end", column: "done" },
  ],
  edges: [
    { from: "start", to: "execute" },
    { from: "execute", to: "review", condition: "success" },
    { from: "review", to: "end", condition: "success" },
    { from: "execute", to: "end", condition: "failure" },
    { from: "review", to: "end", condition: "failure" },
  ],
  settings: BUILTIN_WORKFLOW_SETTINGS,
};

/** The coding company board template (default for new flag-on boards). */
export const COMPANY_BOARD_TEMPLATE_IR = parseWorkflowIr(RAW_COMPANY_BOARD_TEMPLATE_IR);

/** The non-coding company board template (no branch/merge machinery, R6). */
export const COMPANY_BOARD_TEMPLATE_NON_CODING_IR = parseWorkflowIr(
  RAW_COMPANY_BOARD_TEMPLATE_NON_CODING_IR,
);

/**
 * True when an IR carries the company-model markers — i.e. at least one column
 * declares a `role`. This is the single authority for "is this a company-model
 * board" used by the placement (workflow-reconciliation) and movement
 * (workflow-transitions) rules, so the new checks fire only for boards built on
 * the company template; every legacy/custom workflow (which never sets `role`)
 * stays on the unchanged path even when the flag is on.
 */
export function isCompanyBoardIr(ir: WorkflowIr): boolean {
  if (ir.version !== "v2") return false;
  return ir.columns.some((c) => c.role !== undefined);
}
