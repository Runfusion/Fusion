/*
FNXC:PostgresCutover 2026-07-12:
Mesh task replication is REMOVED — all replication is handled at the
PostgreSQL level (nodes share the database). This module used to carry the
replicated-create payload builders/matchers; only buildBootstrapPrompt
survives because task creation, comments, and title/description sync use it
to write the human-visible PROMPT.md stub.
*/

export function buildBootstrapPrompt(taskId: string, title: string | undefined, description: string): string {
  const heading = title ? `${taskId}: ${title}` : taskId;
  return `# ${heading}\n\n${description}\n`;
}

/*
FNXC:TaskRefinementWorkflow 2026-07-13-12:00:
The single source of truth for the refinement seed shape. TaskStore.refineTask writes this
exact content and isUnplannedSeedPrompt detects it by byte-equality — keep both on this
builder or the detector silently stops matching when the seed format changes, and unplanned
refinements release into execution again.
*/
export function buildRefinementSeedPrompt(title: string, description: string): string {
  return `# ${title}\n\n${description}\n`;
}

/*
FNXC:WorkflowScheduling 2026-07-12-22:55:
"Unplanned" detection must recognize BOTH seed-prompt shapes or unplanned cards slip into
execution with a non-spec prompt:
1. The createTask bootstrap stub (`# {id}: {title}\n\n{description}\n`).
2. The refineTask seed (buildRefinementSeedPrompt — no task-id prefix), which previously
   failed the strict stub-equality check, so a refinement promoted out of a manual intake
   column (Coding (Ideas)) was treated as already planned and released straight into
   execution carrying only the operator's feedback text.
Callers: triage todo-discovery (plan-in-place workflows) and hold-release's
isUnplannedForExecution guard.
*/
export function isUnplannedSeedPrompt(
  content: string,
  taskId: string,
  title: string | undefined,
  description: string,
): boolean {
  if (content === buildBootstrapPrompt(taskId, title, description)) return true;
  return title !== undefined && content === buildRefinementSeedPrompt(title, description);
}
