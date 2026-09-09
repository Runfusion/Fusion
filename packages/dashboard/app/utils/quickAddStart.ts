import type { BoardWorkflowDefinition } from "../api";

export type ValidatedQuickAddWorkflow = BoardWorkflowDefinition;

/**
 * FNXC:QuickAddStart 2026-07-22-16:10:
 * Start is exposed only after a complete runtime validation, rather than trusting stale
 * dashboard metadata. This keeps touch/pen long-press and mouse right-click affordances
 * unavailable unless the submitted workflow can prove its ordered routing columns.
 */
export function validateQuickAddStartWorkflow(value: unknown): ValidatedQuickAddWorkflow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const workflow = value as Partial<BoardWorkflowDefinition>;
  if (typeof workflow.id !== "string" || !workflow.id.trim() || workflow.id === "__all_workflows__") return null;
  if (!Array.isArray(workflow.columns) || workflow.columns.length === 0) return null;
  const ids = new Set<string>();
  for (const column of workflow.columns) {
    if (!column || typeof column !== "object" || Array.isArray(column)) return null;
    if (typeof column.id !== "string" || !column.id.trim() || ids.has(column.id)) return null;
    if (!column.flags || typeof column.flags !== "object" || Array.isArray(column.flags)) return null;
    ids.add(column.id);
  }
  return workflow as ValidatedQuickAddWorkflow;
}

/* FNXC:TaskArchiveRemoval 2026-09-04-14:51: Workflow metadata has no Archived role; visibility is determined solely by the board-hidden contract. */
function visibleColumns(workflow: ValidatedQuickAddWorkflow) {
  return workflow.columns.filter((column) => !column.flags.hiddenFromBoard);
}

/*
 * FNXC:QuickAddStart 2026-07-31-23:51:
 * Start is reserved for a workflow's first visible manual/waiting intake lane. `hold` alone is
 * insufficient because the canonical merged Planning column carries both `intake` and `hold` while
 * auto-triaging. Mirror TaskCard.showStartAction's server-derived `manualIntake` fact so absent
 * older payload metadata fails closed without exposing an unusable Quick Add action.
 */
export function workflowSupportsQuickAddStart(workflow: ValidatedQuickAddWorkflow | null): boolean {
  if (!workflow) return false;
  if (workflow.id === "builtin:coding-ideas-v2") return true;
  return visibleColumns(workflow)[0]?.flags.manualIntake === true;
}

/**
 * FNXC:QuickAddStart 2026-07-22-16:10:
 * Custom hold-workflow Start promotion uses the returned task's actual column and moves forward only to
 * a later working column. Missing data, holds, complete lanes, or no later destination are
 * successful create-only outcomes; Quick Add never guesses `todo` or moves backwards.
 *
 * FNXC:QuickAddStart 2026-08-26-19:19:
 * The forward step is now the IMMEDIATELY following visible column, and a `hold` lane is a legal
 * destination rather than something to skip. Skipping holds produced a move the server always
 * refuses: column adjacency permits `intake -> hold` only (ROLE_TRANSITIONS in
 * packages/core/src/workflows/workflow-transitions.ts), and neighbour-derived adjacency for
 * genuinely custom shapes permits the next declared column only. Jumping over a Planning hold lane
 * into the WIP lane therefore returned 409 "Invalid transition: 'ideas' -> 'in-progress'", so Start
 * created a card that never started. One legal forward step is the only promotion Quick Add can
 * prove; anything further is the operator's move to make.
 */
export function resolveQuickAddStartTargetColumn(workflow: ValidatedQuickAddWorkflow, createdColumn: unknown): string | null {
  if (typeof createdColumn !== "string" || !createdColumn.trim()) return null;
  const columns = visibleColumns(workflow);
  const createdIndex = columns.findIndex((column) => column.id === createdColumn);
  if (createdIndex < 0) return null;
  const next = columns[createdIndex + 1];
  if (!next || next.flags.intake || next.flags.complete) return null;
  return next.id;
}

/*
FNXC:QuickAddStart 2026-09-06-02:15:
A duplicated or hand-authored Ideas workflow must start exactly like the built-in one. The atomic create-in-Planning path keys on the surviving `builtin:coding-ideas-v2` identity; every other manual-intake workflow continues through trait resolution.

The destination is derived from the SAME traits the server uses, not from a name: a create lands in
the planning lane pre-planned only when `resolveWorkflowIntakeFacts` classifies it as an unplanned
Start create, and that check is `task.column === columnsWithFlag(ir, "hold")[0]` on a manual-intake
workflow (packages/core/src/task-store/task-creation.ts). Submitting any OTHER column earns
`generateSpecifiedPrompt` instead of the bootstrap seed, and triage only admits seed prompts — the
card would sit in Planning looking planned, forever (FN-8587). So the candidate must be the first
DECLARED hold column (hidden lanes included, exactly as the server scans them) and must sit
immediately after the manual intake. Anything else fails closed to the one-step promotion path,
which is legal under column adjacency.
*/
function resolveManualIntakePlanningColumn(workflow: ValidatedQuickAddWorkflow): string | null {
  const columns = visibleColumns(workflow);
  const intake = columns[0];
  if (!intake || intake.flags.manualIntake !== true) return null;
  const planning = columns[1];
  if (!planning || planning.flags.hold !== true || planning.flags.intake || planning.flags.complete) return null;
  if (workflow.columns.find((column) => column.flags.hold === true)?.id !== planning.id) return null;
  return planning.id;
}

/**
 * FNXC:QuickAddStart 2026-07-22-17:45:
 * Coding (Ideas) Start must atomically create in Todo, while ordinary Save/Enter still create
 * in Ideas. Prove the destination from the captured, ordered visible definition: Ideas must
 * precede one non-intake, non-complete Todo lane. Missing, hidden, reordered, or malformed
 * metadata fails closed rather than guessing a transition.
 */
/*
FNXC:NewTaskWorkflowStart 2026-08-19-00:17:
The modal and QuickEntryBox must hide Start when the metadata proves manual intake but no later
working lane exists. Resolve that proof from the same ordered workflow snapshot used for the actual
create or move, retaining the Coding (Ideas) atomic-column special case.

FNXC:WorkflowSuccession 2026-09-06-02:15:
The named special case now belongs only to the surviving Ideas id. Its normal five-column metadata resolves the same `todo` target as the generic trait path; malformed or reordered successor metadata fails closed instead of falling back to a guessed promotion.
*/
export function resolveQuickAddStartWorkflowTarget(workflow: ValidatedQuickAddWorkflow | null): string | null {
  if (!workflow || !workflowSupportsQuickAddStart(workflow)) return null;
  const initialColumn = resolveQuickAddStartInitialColumn(workflow);
  if (initialColumn) return initialColumn;
  if (workflow.id === "builtin:coding-ideas-v2") return null;
  const intakeColumn = visibleColumns(workflow)[0]?.id;
  return intakeColumn ? resolveQuickAddStartTargetColumn(workflow, intakeColumn) : null;
}

export function resolveQuickAddStartInitialColumn(workflow: ValidatedQuickAddWorkflow): string | null {
  /* FNXC:QuickAddStart 2026-08-26-19:19: every other workflow — including a duplicate of this one —
     resolves its planning lane from traits instead of returning null. */
  if (workflow.id !== "builtin:coding-ideas-v2") return resolveManualIntakePlanningColumn(workflow);
  const columns = visibleColumns(workflow);
  /*
  DELIBERATE-LITERAL — these are ONE NAMED BUILTIN's own declared ids, not a lifecycle guard.

  Census false positive. The function returns null two lines above for any workflow other than
  `builtin:coding-ideas-v2`, so `ideas` and `todo` here are that workflow's OWN column ids, read from
  its captured definition — there is no other board whose vocabulary could differ. A custom workflow
  never reaches this line.

  The lifecycle question this function does ask IS already trait-resolved: the destination is
  rejected below unless `!todo.flags.intake && !todo.flags.complete`. Replacing the id lookups with
  role resolution would not make it more correct — it would make it match a DIFFERENT column in the
  one workflow this is scoped to.
  */
  const ideasIndex = columns.findIndex((column) => column.id === "ideas");
  /* DELIBERATE-LITERAL — see the note above: this is `builtin:coding-ideas-v2`'s OWN `todo` id, and the
     function has already returned null for every other workflow. */
  const todoIndex = columns.findIndex((column) => column.id === "todo");
  if (ideasIndex < 0 || todoIndex <= ideasIndex) return null;

  const todo = columns[todoIndex];
  if (!todo || todo.flags.intake || todo.flags.complete) return null;
  return todo.id;
}
