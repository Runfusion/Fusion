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
 *    (U5), so the company board's working entry column is `todo` directly.
 *  - An unstaffed, locked `idea` intake column sits BEFORE `todo` (R5/KTD):
 *    user-created tasks land there; CEO-routed tasks land in Todo. The idea
 *    column carries the `intake` trait, has no `role` marker (it is never a
 *    mandatory-role-staffing column, so U2's staffing validation ignores it) and
 *    is never picked up by the Lead triage scan / dispatch (those gate on the
 *    todo column id specifically).
 *  - The three role columns (todo / in-progress / in-review) carry company-model
 *    markers: `role` ("lead" | "executor" | "reviewer") and `locked: true`.
 *    These markers are the carrier the placement/movement rules key off
 *    (workflow-reconciliation, workflow-transitions): a board whose IR carries
 *    them is a company-model board; one that doesn't stays on the legacy path.
 *    Legacy/default workflows never set them, so flag-off behavior is byte-
 *    identical.
 *
 * Single variant: every company board keeps the full merge machinery (R6) — a
 * non-coding board differs only by agent instructions (no code enforces that), so
 * there is no merge-less column variant.
 *
 * Trait mapping mirrors the legacy semantics for the columns that exist:
 *   idea        = intake
 *   todo        = hold(capacity) + reset-on-entry
 *   in-progress = wip + abort-on-exit + timing
 *   in-review   = merge-blocker + stall-detection + merge
 *   done        = complete
 *   archived    = archived
 *
 * The graph (nodes/edges) reuses the coding pipeline's execute → review → merge
 * walk (the `idea` column is intake-only and carries no automation node).
 */

import type { WorkflowIr, WorkflowIrColumn, WorkflowColumnRole } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";

/** The company board's column ids in board order. The unstaffed locked `idea`
 *  intake column leads; `todo` is the working entry column. Custom columns may be
 *  inserted between todo and in-review, and after in-review before done (R2) —
 *  never before todo (idea is the only pre-todo column). */
export const COMPANY_BOARD_COLUMN_IDS = [
  "idea",
  "todo",
  "in-progress",
  "in-review",
  "done",
  "archived",
] as const;

/** The unstaffed, locked intake column before todo (R5/KTD). No `role` marker —
 *  it is never a mandatory-role-staffing column. User-created tasks land here;
 *  CEO-routed tasks land in todo. The Lead triage scan / dispatch never pick it
 *  up (they gate on the todo column id). */
const IDEA_COLUMN: WorkflowIrColumn = {
  id: "idea",
  name: "Idea",
  locked: true,
  traits: [{ trait: "intake" }],
};

/** The two locked role columns at the head of the working pipeline (R1). */
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

/** The Reviewer's in-review column: full merge machinery, mirroring legacy
 *  semantics (R6 — every company board keeps the merge machinery). */
const IN_REVIEW_CODING: WorkflowIrColumn = {
  id: "in-review",
  name: "In review",
  role: "reviewer",
  locked: true,
  traits: [{ trait: "merge-blocker" }, { trait: "stall-detection" }, { trait: "merge" }],
};

const RAW_COMPANY_BOARD_TEMPLATE_IR: WorkflowIr = {
  version: "v2",
  name: "company-board-template",
  columns: [IDEA_COLUMN, ...ROLE_COLUMNS, IN_REVIEW_CODING, ...TAIL_COLUMNS],
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

/** The company board template (default for new flag-on boards). Every company
 *  board keeps the full merge machinery (R6); non-coding boards differ only by
 *  agent instructions. */
export const COMPANY_BOARD_TEMPLATE_IR = parseWorkflowIr(RAW_COMPANY_BOARD_TEMPLATE_IR);

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

/**
 * The column id carrying the given company-model role on a board IR, or
 * undefined when the IR is not a v2 company board or no column holds the role.
 * Used by U5's Lead-triage path to locate the Lead column (`role === "lead"`,
 * the company template's `todo`) without hard-coding the literal id, so a future
 * template rename does not silently break the triage scan or recovery re-target.
 */
export function resolveCompanyRoleColumnId(
  ir: WorkflowIr,
  role: WorkflowColumnRole,
): string | undefined {
  if (ir.version !== "v2") return undefined;
  return ir.columns.find((c) => c.role === role)?.id;
}
