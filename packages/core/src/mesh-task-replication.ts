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
FNXC:WorkflowScheduling 2026-07-25-11:20:
Seed detection compares NORMALIZED text, not raw bytes. Symptom it fixes: a Coding (Ideas) card
promoted to Todo was never planned — triage's todo-discovery only admits a card whose PROMPT.md
still reads as a seed, and any byte-level drift from the builder output silently reclassified the
card as "already planned", so it sat in Todo forever with no log line. Drift sources are all
benign and outside the writer's control: a CRLF checkout/editor round-trip, an editor that adds or
strips the trailing newline, or trailing spaces. Normalization is line-ending + trailing-whitespace
only — the heading and body text still must match exactly, so a REAL spec can never normalize into
a seed (it carries Mission/Steps/File Scope sections the seed does not have).
*/
function normalizeSeedText(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
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

FNXC:WorkflowScheduling 2026-07-25-11:20:
This is the SINGLE seed predicate for every scheduling decision. The dispatch filter in
scheduler.ts used to open-code strict `content === buildBootstrapPrompt(...)`, which disagreed
with this function on the refinement seed: triage called such a card unplanned (so it planned it)
while the scheduler called it planned (so it was also a dispatch candidate), leaving hold-release
as the only thing between a refinement seed and an executor running on the operator's feedback
text. Callers: triage todo-discovery (plan-in-place workflows), the scheduler dispatch filter, and
hold-release's isUnplannedForExecution guard. Do not re-open-code either equality check.
*/
export function isUnplannedSeedPrompt(
  content: string,
  taskId: string,
  title: string | undefined,
  description: string,
): boolean {
  const normalized = normalizeSeedText(content);
  if (normalized === normalizeSeedText(buildBootstrapPrompt(taskId, title, description))) return true;
  return title !== undefined
    && normalized === normalizeSeedText(buildRefinementSeedPrompt(title, description));
}

/**
 * Durable statuses that park a plan-in-place card for another planning pass regardless of what its
 * PROMPT.md currently says. Mirrors triage todo-discovery's `needs-replan` branch — Plan Review
 * rejected the current spec, so the real (rejected) prompt must not read as "already planned".
 */
const AWAITING_PLANNING_STATUSES = new Set(["needs-replan"]);

/*
FNXC:CodingIdeasWorkflow 2026-07-26-15:30:
Whether a plan-in-place (Todo) card is waiting for a PLANNING slot rather than a WIP slot — the
question the "Queued to plan" / "Ready" badge pair answers.

Requirement: the badge must not contradict the engine. It used to infer "unplanned" from
`steps.length === 0`, while every engine lane decides from PROMPT.md seed-ness, so the two disagreed
in both directions: a card with a real spec but no parsed steps was labelled "Queued to plan" while
the scheduler was actually treating it as a dispatch candidate (waiting for a WIP slot, i.e. Ready),
and a re-seeded card still carrying steps from a previous pass was labelled "Ready" while triage was
about to plan it. The badge exists to make the FN-8600 planning-capacity wait legible, so a wrong
label sends operators to the wrong cap.

`promptContent === null` means PROMPT.md is missing, which triage treats as unplanned (it
regenerates the spec) rather than as planned. Kept pure — the fs read belongs to the caller, so
this stays usable from the API layer, the engine, and tests alike.

Callers: the `GET /api/tasks` board enrichment (`awaitingPlanning`) and triage's todo-discovery
content branch. Do not re-open-code the status set or the seed check.
*/
export function isTaskAwaitingPlanning(
  task: { id: string; title?: string; description: string; status?: string | null },
  promptContent: string | null,
): boolean {
  if (task.status != null && AWAITING_PLANNING_STATUSES.has(task.status)) return true;
  if (promptContent === null) return true;
  return isUnplannedSeedPrompt(promptContent, task.id, task.title, task.description);
}
