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

function visibleColumns(workflow: ValidatedQuickAddWorkflow) {
  return workflow.columns.filter((column) => !column.flags.archived && !column.flags.hiddenFromBoard);
}

export function workflowSupportsQuickAddStart(workflow: ValidatedQuickAddWorkflow | null): boolean {
  if (!workflow) return false;
  if (workflow.id === "builtin:coding-ideas") return true;
  return visibleColumns(workflow)[0]?.flags.hold === true;
}

/**
 * FNXC:QuickAddStart 2026-07-22-16:10:
 * Custom hold-workflow Start promotion uses the returned task's actual column and moves forward only to
 * a later working column. Missing data, holds, complete lanes, or no later destination are
 * successful create-only outcomes; Quick Add never guesses `todo` or moves backwards.
 */
export function resolveQuickAddStartTargetColumn(workflow: ValidatedQuickAddWorkflow, createdColumn: unknown): string | null {
  if (typeof createdColumn !== "string" || !createdColumn.trim()) return null;
  const columns = visibleColumns(workflow);
  const createdIndex = columns.findIndex((column) => column.id === createdColumn);
  if (createdIndex < 0) return null;
  for (const column of columns.slice(createdIndex + 1)) {
    if (!column.flags.intake && !column.flags.hold && !column.flags.complete) return column.id;
  }
  return null;
}

/**
 * FNXC:QuickAddStart 2026-07-22-17:45:
 * Coding (Ideas) Start must atomically create in Todo, while ordinary Save/Enter still create
 * in Ideas. Prove the destination from the captured, ordered visible definition: Ideas must
 * precede one non-intake, non-complete Todo lane. Missing, hidden, reordered, or malformed
 * metadata fails closed rather than guessing a transition.
 */
export function resolveQuickAddStartInitialColumn(workflow: ValidatedQuickAddWorkflow): string | null {
  if (workflow.id !== "builtin:coding-ideas") return null;
  const columns = visibleColumns(workflow);
  const ideasIndex = columns.findIndex((column) => column.id === "ideas");
  const todoIndex = columns.findIndex((column) => column.id === "todo");
  if (ideasIndex < 0 || todoIndex <= ideasIndex) return null;

  const todo = columns[todoIndex];
  if (!todo || todo.flags.intake || todo.flags.complete) return null;
  return todo.id;
}
