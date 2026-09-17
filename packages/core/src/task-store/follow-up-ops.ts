/*
FNXC:TaskFollowUp 2026-09-17-16:20:
FN-513 — the FOLLOW-UP creation mode of `TaskStore.refineTask`.

WHAT IT IS. An operator asks, from a task A that is still planning, running, or in review, for a
successor task B derived from A's plan and its in-flight implementation. B is an ordinary durable
task: its own steps, its own seed prompt, its own worktree later, plus one real dependency edge on A.
Creating B must not touch A at all — no pause, no abort, no retry, no move, no branch copy, no
session reuse. Everything this module does to A is a READ.

WHY IT DOES NOT REUSE `refineTaskImpl`'s CONSTRUCTOR. That path hand-builds the row inside
`createTaskWithDistributedReservation`, so it bypasses `createTaskBackendImpl`'s staging directory,
its in-transaction dependency validation (each prerequisite locked in sorted order and re-read live),
and its post-commit selection publication. A follow-up's whole point is a dependency edge on a row
that is concurrently mutating, so the validation it skips is exactly the validation it needs. This
module therefore goes through `createTask` and adds its revalidation via the internal
`afterTaskInsert` transaction hook.

THE TWO ORDERS, DECIDED ON PURPOSE.
  - a delete / terminal move / invalidating replan of A that commits BEFORE the insert  -> no B, no
    success event; the caller sees a typed `FollowUpIneligibleError`.
  - the insert commits first -> B is durable and A is protected from then on by the ordinary
    dependency and lineage guards. A moving WIP -> review, or Planning-approved -> WIP, is still
    admissible: progress that does not remove eligibility never cancels the request.

REENTRANCY. The hook runs INSIDE `createTaskBackendImpl`'s insert transaction, after that
transaction has already taken the advisory lock on every dependency target — which includes A,
because B depends on A. It must therefore read A through the SAME `tx`. Calling `store.getTask` there
would take its own lock and open its own reads against a different connection, which is how a
create-inside-a-lock deadlocks. Resolving A's workflow IR is likewise a store read, so every
column-role fact is resolved BEFORE the transaction and looked up from an immutable snapshot inside
it; a workflow selection that changed in between is an explicit conflict rather than a silent reuse
of stale roles.
*/
import { and, eq } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { DbTransaction } from "../postgres/data-layer.js";
import { projectScopeFor } from "../postgres/data-layer.js";
import { readTaskRowInTransaction } from "./async/async-persistence.js";
import { resolveWorkflowIrForTask, resolveWorkflowIrById } from "../workflows/workflow-ir-resolver.js";
import { getTraitRegistry } from "../workflows/trait-registry.js";
import type { WorkflowIr, WorkflowIrColumn } from "../workflows/workflow-ir-types.js";
import { resolveWorkflowIntakeFacts } from "./task-creation.js";
import { deriveFallbackTaskTitle } from "../ai/ai-summarize.js";
import { generateTaskLineageId } from "../tasks/task-lineage.js";
import {
  buildFollowUpSourceMetadata,
  evaluateFollowUpEligibility,
  type FollowUpColumnFlags,
  type FollowUpEligibilityInput,
  type FollowUpIneligibleReason,
} from "../tasks/task-follow-up.js";
import { MAX_TASK_MESSAGE_LENGTH, type Task, type TaskCreateInput } from "../types.js";
import { TaskStore, storeLog } from "../store.js";
import "../builtin-traits.js";

/* -------------------------------------------------------------------------- */
/* Typed refusals                                                              */
/* -------------------------------------------------------------------------- */

/*
FNXC:TaskFollowUp 2026-09-17-16:20:
Typed refusals, never prose the HTTP layer has to string-match. The route maps `source-missing` to
404 and every other reason to 409; a message that named English column ids would be both wrong on a
renamed board and unusable as a branch condition.
*/
export type FollowUpRefusalReason =
  | FollowUpIneligibleReason
  | "source-missing"
  | "destination-unavailable"
  | "workflow-selection-changed";

export class FollowUpIneligibleError extends Error {
  public readonly reason: FollowUpRefusalReason;
  public readonly taskId: string;
  constructor(taskId: string, reason: FollowUpRefusalReason, message?: string) {
    super(message ?? `Cannot create a follow-up of ${taskId}: ${reason}`);
    this.name = "FollowUpIneligibleError";
    this.reason = reason;
    this.taskId = taskId;
  }
}

/** A refusal raised from inside the insert transaction still classifies as a refusal. */
export function isFollowUpIneligibleError(error: unknown): error is FollowUpIneligibleError {
  return error instanceof FollowUpIneligibleError
    || (error instanceof Error && error.name === "FollowUpIneligibleError");
}

/* -------------------------------------------------------------------------- */
/* Column-role snapshot                                                        */
/* -------------------------------------------------------------------------- */

/*
FNXC:TaskFollowUp 2026-09-17-16:20:
`manualIntake` is trait CONFIG (`intake` with `autoTriage: false`), not a trait flag, so it cannot be
read off `resolveColumnFlags`. The dashboard derives it the same way in `board-workflows.ts`; the
duplication is two lines of config reading rather than a second eligibility rule, and the RULE — the
part that can drift — lives once in `tasks/task-follow-up.ts`.
*/
function isManualIntakeColumn(column: WorkflowIrColumn): boolean {
  const flags = getTraitRegistry().resolveColumnFlags(column);
  if (flags.intake !== true) return false;
  const intakeTrait = (column.traits ?? []).find((trait) => trait.trait === "intake");
  return (intakeTrait?.config as { autoTriage?: boolean } | undefined)?.autoTriage === false;
}

/**
 * Every declared column's role flags, resolved ONCE before the insert transaction.
 *
 * A map rather than a single column's flags because A may legally move while the request is in
 * flight (WIP -> review). The revalidation inside the transaction needs the new column's roles and
 * cannot perform a store read to get them.
 */
export function resolveFollowUpColumnFlagMap(ir: WorkflowIr): Map<string, FollowUpColumnFlags> {
  const map = new Map<string, FollowUpColumnFlags>();
  if (ir.version !== "v2") return map;
  for (const column of ir.columns) {
    map.set(column.id, {
      ...getTraitRegistry().resolveColumnFlags(column),
      ...(isManualIntakeColumn(column) ? { manualIntake: true } : {}),
    });
  }
  return map;
}

function eligibilityInputFor(
  task: Pick<Task, "column" | "status" | "deletedAt" | "workflowStepResults">,
  flagMap: Map<string, FollowUpColumnFlags>,
): FollowUpEligibilityInput {
  const flags = flagMap.get(task.column);
  return {
    column: task.column,
    ...(flags ? { columnFlags: flags } : {}),
    status: task.status ?? null,
    deletedAt: task.deletedAt ?? null,
    workflowStepResults: task.workflowStepResults ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateFollowUpTaskOptions {
  /** Internal test seam: runs once the insert transaction holds A's advisory lock. */
  __afterSourceLockForTest?: () => void | Promise<void>;
}

/** The internal shape `createTaskBackendImpl` reads its transaction hook from. */
type CreateTaskWithAfterInsert = TaskCreateInput & {
  afterTaskInsert?: (tx: DbTransaction, task: Task) => Promise<void>;
};

export async function createFollowUpTaskImpl(
  store: TaskStore,
  id: string,
  feedback: string,
  options?: CreateFollowUpTaskOptions,
): Promise<Task> {
  /*
  FNXC:TaskFollowUp 2026-09-17-16:20:
  The domain validates the request text too. The HTTP route validates it first for a clean 400, but
  the store is reachable from the CLI and from tests, and a store that trusted its caller would be
  the only writer of an unbounded description.
  */
  const trimmed = feedback?.trim() ?? "";
  if (!trimmed) throw new Error("Feedback is required and cannot be empty");
  if (feedback.length > MAX_TASK_MESSAGE_LENGTH) {
    throw new Error(`Feedback must be at most ${MAX_TASK_MESSAGE_LENGTH} characters`);
  }

  let sourceTask: Task | null;
  try {
    sourceTask = await store.getTask(id);
  } catch {
    sourceTask = null;
  }
  if (!sourceTask || sourceTask.deletedAt) {
    throw new FollowUpIneligibleError(id, sourceTask ? "source-deleted" : "source-missing");
  }

  // Roles come from A's OWN workflow — the child's destination workflow is resolved separately below.
  const sourceIr = await resolveWorkflowIrForTask(store, id);
  const sourceFlagMap = resolveFollowUpColumnFlagMap(sourceIr);
  const initialVerdict = evaluateFollowUpEligibility(eligibilityInputFor(sourceTask, sourceFlagMap));
  if (!initialVerdict.eligible) {
    throw new FollowUpIneligibleError(id, initialVerdict.reason);
  }

  const sourceWorkflowId = (await readTaskWorkflowSelectionId(store, id)) ?? null;

  /*
  FNXC:TaskFollowUp 2026-09-17-16:20:
  The CHILD's workflow is the refinement-origin workflow, exactly as Refine resolves it — not A's
  workflow (a follow-up is not a continuation of A's pipeline) and not the operator's Board filter
  (a view is not a choice). A manual capture lane is bypassed to that workflow's Planning hold so B
  is actionable immediately, matching FNXC:RefinementPlanningRouting.

  The one deliberate divergence from Refine: a manual workflow with NO usable hold is REFUSED rather
  than dropped into the legacy `triage` literal. Refine keeps that fallback for backward
  compatibility; a new mode must not invent a column the board does not declare.
  */
  let childWorkflowSelection: { workflowId: string; stepIds: string[] } | undefined;
  try {
    const override = await store.resolveOriginWorkflowOverrideId("refinement");
    const inherited = override
      ? await store.materializeExplicitWorkflowSteps(override)
      : await store.materializeDefaultWorkflowSteps();
    if (inherited) childWorkflowSelection = inherited;
  } catch (err) {
    storeLog.warn("Failed to resolve the follow-up destination workflow", {
      phase: "followUpTask:default-workflow",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const intakeFacts = await resolveWorkflowIntakeFacts(store, childWorkflowSelection?.workflowId);
  const destinationColumn = intakeFacts.manual ? intakeFacts.hold : intakeFacts.intake;
  if (!destinationColumn) {
    throw new FollowUpIneligibleError(id, "destination-unavailable");
  }

  /*
  A follow-up is titled by the OPERATOR'S request, like a refinement and like any created task — not
  by A's title, which would make every sibling of one parent render identically (FNXC:RefinementTitle).
  */
  const title = deriveFallbackTaskTitle(trimmed) ?? undefined;

  const input: CreateTaskWithAfterInsert = {
    description: `${trimmed}\n\nFollows up on: ${id}`,
    ...(title ? { title } : {}),
    lineageId: generateTaskLineageId(),
    column: destinationColumn,
    dependencies: [id],
    ...(childWorkflowSelection ? { workflowId: childWorkflowSelection.workflowId } : {}),
    /*
    FNXC:TaskFollowUp 2026-09-17-16:20:
    Linking intent is inherited from A exactly as Refine inherits it, so an unlinked parent does not
    silently produce a tracked child. Nothing else of A is copied: no session, no review results, no
    step progress, no branch or worktree, no pause or error state. A's attachments stay A's — the
    planner may QUOTE them read-only as context, but they are not deliverables of B.
    */
    githubTracking: sourceTask.githubTracking?.enabled === true || Boolean(sourceTask.githubTracking?.issue)
      ? {
        enabled: true,
        ...(sourceTask.githubTracking?.repoOverride ? { repoOverride: sourceTask.githubTracking.repoOverride } : {}),
      }
      : { enabled: false },
    source: {
      sourceType: "task_refine",
      sourceParentTaskId: id,
      sourceMetadata: buildFollowUpSourceMetadata(),
    },
    afterTaskInsert: async (tx, created) => {
      await options?.__afterSourceLockForTest?.();
      await assertSourceStillEligibleInTransaction(store, tx, id, sourceFlagMap, sourceWorkflowId);
      storeLog.log(`[follow-up] ${created.id} created from ${id} (${initialVerdict.lane} lane)`);
    },
  };

  const child = await store.createTask(input);

  try {
    await store.logEntry(child.id, `Created as follow-up of ${id}`);
  } catch {
    /*
    Post-commit annotation only. B is already durable and already published; turning a committed
    creation into a retryable failure here would be the worse outcome by far — the operator would
    resubmit and get a second child.
    */
  }

  return child;
}

/**
 * Read A's persisted workflow selection id without taking a second lock.
 *
 * Returns `null` for "no explicit selection", which is a stable fact: B's revalidation compares it
 * to the same read performed inside the transaction, so "still unselected" and "still selection X"
 * are both unchanged, while a change between them is an explicit conflict.
 */
async function readTaskWorkflowSelectionId(store: TaskStore, id: string): Promise<string | null> {
  try {
    const selection = await store.getTaskWorkflowSelectionAsync(id);
    return selection?.workflowId ?? null;
  } catch {
    return null;
  }
}

/*
FNXC:TaskFollowUp 2026-09-17-16:20:
THE REVALIDATION. It runs inside `createTaskBackendImpl`'s insert transaction, which has already
acquired A's advisory lock (A is B's dependency) and already proved A is live and not soft-deleted.
Throwing here rolls back B's row AND the staged task directory through the existing cleanup, so a
refusal leaves no partial child and no orphaned files.

It re-reads A through `tx` — never `store.getTask`, which would take its own lock on a different
connection inside a held transaction. Column roles come from the pre-transaction snapshot; if A's
workflow SELECTION changed since that snapshot the roles may no longer describe the same lanes, so
that is an explicit `workflow-selection-changed` conflict rather than a silent reuse.
*/
async function assertSourceStillEligibleInTransaction(
  store: TaskStore,
  tx: DbTransaction,
  id: string,
  flagMap: Map<string, FollowUpColumnFlags>,
  expectedWorkflowId: string | null,
): Promise<void> {
  const layer = store.asyncLayer!;
  const row = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, layer.projectId);
  if (!row) throw new FollowUpIneligibleError(id, "source-missing");

  const live = store.rowToTask(store.pgRowToTaskRow(row));
  if (live.deletedAt) throw new FollowUpIneligibleError(id, "source-deleted");

  const [selection] = await tx
    .select({ workflowId: schema.project.taskWorkflowSelection.workflowId })
    .from(schema.project.taskWorkflowSelection)
    .where(and(
      projectScopeFor(schema.project.taskWorkflowSelection.projectId, layer.projectId),
      eq(schema.project.taskWorkflowSelection.taskId, id),
    ));
  const liveWorkflowId = selection?.workflowId ?? null;
  if (liveWorkflowId !== expectedWorkflowId) {
    throw new FollowUpIneligibleError(id, "workflow-selection-changed");
  }

  const verdict = evaluateFollowUpEligibility(eligibilityInputFor(live, flagMap));
  if (!verdict.eligible) throw new FollowUpIneligibleError(id, verdict.reason);
}

/*
FNXC:TaskFollowUp 2026-09-17-16:20:
Exported for the HTTP route so the SERVER resolves A's lane with the same IR + trait derivation the
store revalidates against, instead of trusting a client-supplied column role.
*/
export async function evaluateFollowUpEligibilityForTask(
  store: TaskStore,
  task: Pick<Task, "id" | "column" | "status" | "deletedAt" | "workflowStepResults">,
): Promise<ReturnType<typeof evaluateFollowUpEligibility>> {
  const ir = await resolveWorkflowIrForTask(store, task.id);
  return evaluateFollowUpEligibility(eligibilityInputFor(task, resolveFollowUpColumnFlagMap(ir)));
}

/** Resolve a workflow's column-role snapshot by id (used by surfaces that already hold an id). */
export async function resolveFollowUpColumnFlagMapById(
  store: TaskStore,
  workflowId: string,
): Promise<Map<string, FollowUpColumnFlags>> {
  return resolveFollowUpColumnFlagMap(await resolveWorkflowIrById(store, workflowId));
}
