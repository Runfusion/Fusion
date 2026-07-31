import { createLogger } from "../logger.js";
import { columnsWithFlag, declaresAnyLifecycleTrait } from "../workflow-lifecycle-traits.js";

const severityAuditLog = createLogger("core-comments-ops");
/**
 * comments-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {existsSync} from "node:fs";
import type {ArchivedTaskDocumentAdditionInput, ArchivedTaskDocumentAdditionResult, Task, TaskDocument, TaskDocumentCreateInput, TaskLogEntry, RunMutationContext} from "../types.js";
import {validateDocumentKey} from "../types.js";
import {ArchivedTaskDocumentPublicationRejectedError, validateArchivedTaskDocumentAddition, validateTaskDocumentPreconditions} from "../task-document-concurrency.js";
import "../builtin-traits.js";
import {resolveWorkflowIrForTask} from "../workflow-ir-resolver.js";
import {resolveLifecycleColumns} from "../workflow-lifecycle-traits.js";
import {__setTaskActivityLogLimitsForTesting, isBootstrapPromptStub} from "../task-store/comments.js";
import { resolveArchivedLanes } from "../project-lane-vocabulary.js";
import {getLiveTaskColumn, publishArchivedTaskDocumentAddition as publishArchivedTaskDocumentAdditionAsync, upsertTaskDocument as upsertTaskDocumentAsync} from "../task-store/async-comments-attachments.js";

/*
FNXC:PostCommentRetriage 2026-07-29-19:30 (U11 lifecycle-column conversion):
STATUS is the discriminator here, not the column id.

Callers reach this only after establishing the card sits in a pre-implementation
column, so re-testing the column inside was always redundant — and after U11 it was
WRONG. `builtin:coding` resolves to BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR,
whose merged Planning column keeps the id `todo` and declares no `triage` column at
all. The old `column === "triage" && status === "awaiting-approval"` therefore never
matched a default card, and the consequences were graded:

  - with a real spec, the card fell through to the re-triage arm — same
    `needs-replan` write, but audited as "requested re-specification" instead of
    "invalidated spec approval";
  - with a bootstrap-stub spec, `hasRealPrompt` was false and NEITHER arm fired, so
    an operator comment on a card awaiting spec approval invalidated nothing. The
    approval silently stood.

Dropping the column re-checks fixes both and removes 2 of this file's 3 `triage`
literals. The remaining one is the caller's gate (`column === "todo" || column ===
"triage"`), which is deliberately left: it covers BOTH vocabularies, so it still
fires for default cards, and narrowing it to traits needs an IR the caller does not
have.
*/
export function resolvePostCommentRetriageDecision(input: {
  column: string;
  status?: string | null;
  hasRealPrompt: boolean;
}): { invalidateApproval: boolean; retriagePlanned: boolean } {
  const invalidateApproval = input.status === "awaiting-approval";
  const retriagePlanned = input.hasRealPrompt && !invalidateApproval;
  return { invalidateApproval, retriagePlanned };
}

export async function addCommentImpl(store: TaskStore, id: string, text: string, author: string = "user", options?: { skipRefinement?: boolean; source?: "user" | "agent" | "github-review" | "github-review-comment"; externalId?: string; reviewState?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"; }, runContext?: RunMutationContext,): Promise<Task> {
    {
      const layer = store.asyncLayer!;
      const state = await getLiveTaskColumn(layer.db, id, layer.projectId, await resolveArchivedLanes(store));
      /*
      FNXC:LifecycleColumnCensus 2026-07-30-21:10 DELIBERATE-LITERAL: a SENTINEL, not a board lane.
      
      This compares `getLiveTaskColumn`'s RETURN VALUE. That helper normalizes: it manufactures the string
      "archived" for an archived row AND for a soft-deleted one, and returns null for a missing task —
      which is why the neighbouring line tests null separately. It is a protocol value, not a column id.
      
      STILL TRUE NOW THAT THE HELPER RESOLVES LANES. `getLiveTaskColumn` now takes the board's archived
      lanes, which was the one genuinely-owed conversion this family pointed at (#2820). That changes which
      rows it CLASSIFIES as archived; it does not change the SENTINEL it returns, which still collapses
      archived and soft-deleted into one string. Converting this comparison would therefore keep passing on
      the built-in board and start FAILING on a renamed one — a soft-deleted task would read as not-archived.
      */
      if (state === "archived") throw new Error(`Task ${id} is archived — comments are read-only`);
      if (state === null) throw new Error(`Task ${id} not found`);
    }
    // Phase 1: Add comment under lock
    const task = await store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (!task.comments) {
        task.comments = [];
      }

      const externalSource = options?.source;
      const externalId = options?.externalId;
      if (externalSource && externalId) {
        const existing = task.comments.find((entry) => entry.source === externalSource && entry.externalId === externalId);
        if (existing) {
          return task;
        }
      }

      // Generate unique ID: timestamp + random suffix for collision resistance
      const commentId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      const comment: import("../types.js").TaskComment = {
        id: commentId,
        text,
        author,
        createdAt: now,
        updatedAt: now,
        source: options?.source,
        externalId: options?.externalId,
        reviewState: options?.reviewState,
      };

      task.comments.push(comment);
      task.updatedAt = now;
      const logEntry: TaskLogEntry = {
        timestamp: task.updatedAt,
        action: `Comment added by ${author}`,
      };
      if (runContext) {
        logEntry.runContext = runContext;
      }
      task.log.push(logEntry);

      // When runContext is provided, record audit event atomically with task mutation
      if (runContext) {
        await store.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: "task:comment",
          target: task.id,
          metadata: { author, commentId, source: options?.source ?? null, externalId: options?.externalId ?? null },
        });
      } else {
        await store.atomicWriteTaskJson(dir, task);
      }
      if (store.isWatching) store.taskCache.set(id, { ...task });

      store.emit("task:updated", task);
      return task;
    });

    const commentContextBase: Record<string, unknown> = {
      taskId: id,
      author,
      commentLength: text.length,
      column: task.column,
      priorStatus: task.status ?? null,
    };
    if (runContext) {
      commentContextBase.runId = runContext.runId;
      commentContextBase.agentId = runContext.agentId;
      if (runContext.source) {
        commentContextBase.runSource = runContext.source;
      }
    }

    // Phase 2: Auto-refinement OUTSIDE the lock (to avoid lock contention)
    // Only create refinement for user comments on done tasks.
    // This remains best-effort: failures are logged for observability but never
    // fail the comment add operation itself.
    // Steering comments skip refinement — they are injected into the agent stream instead.
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-17:40 (batch-core):
    Auto-refinement fires for a user comment on a FINISHED task. Keyed on the literal, a renamed board
    never created one — an operator commenting on completed work got silence where the feature promises
    a follow-up task, with nothing logged because the branch was simply never entered.

    Complete only, not the landed set: the original fired on `done` alone, and widening it to archival
    would create refinements from comments on archived work that the literal never touched.

    A workflow expressing no trait at all is a v1 upgrade rather than a board without a complete lane,
    so it keeps the legacy id.
    */
    const refinementLanes = new Set<string>(["done"]);
    if (author === "user" && !options?.skipRefinement) {
      try {
        const ir = await resolveWorkflowIrForTask(store, id);
        if (ir && declaresAnyLifecycleTrait(ir)) {
          for (const columnId of columnsWithFlag(ir, "complete")) refinementLanes.add(columnId);
        }
      } catch { /* degraded: the legacy id */ }
    }
    if (refinementLanes.has(task.column) && author === "user" && !options?.skipRefinement) {
      try {
        await store.refineTask(id, text);
      } catch (err) {
        storeLog.warn("Best-effort post-comment auto-refinement failed", {
          ...commentContextBase,
          phase: "addComment:auto-refinement",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 3: user comments on already-planned, non-executing work should
    // trigger triage re-specification. This includes awaiting-approval
    // invalidation and todo/triage tasks that have a real non-bootstrap spec.
    // This remains best-effort: failures are logged for observability but
    // never fail the comment add operation itself.
    // Note: The `task` returned above reflects the state BEFORE this
    // transition. Callers that need the post-transition status should
    // re-read the task (e.g., via getTask).
    /*
    FNXC:PostCommentRetriage 2026-07-30-00:30 (renamed intake column):
    This gate previously listed the two LEGACY ids (`todo`, `triage`). That covers both legacy
    vocabularies but NOT a renamed one: `builtin:coding-ideas` places its intake in `ideas`, matching
    neither, so an operator comment on an Ideas card awaiting spec approval invalidated nothing — the
    approval stood and the task proceeded on the spec being corrected. Identical defect to the one
    #2608 fixed for default cards, one workflow over, and it stayed green because no test drove a
    non-default workflow through here.

    Resolved from the card's own workflow rather than listing ids. The earlier note here said
    narrowing this "needs an IR the caller does not have" — the caller has `store` and `id`, which is
    all `resolveWorkflowIrForTask` needs.

    Two deliberate choices:
      - The IR is only resolved for a USER comment, so agent/system comment traffic pays nothing.
      - An unresolvable workflow falls back to the legacy pair. This is a best-effort re-triage whose
        failure mode is a MISSED re-spec, so keeping the old behaviour beats dropping the card out of
        the branch. Note `resolveLifecycleColumns` throws on a missing IR, so the null-check is
        load-bearing, not defensive decoration.
    */
    const retriageColumns = author === "user"
      ? await (async () => {
        /*
        FNXC:PostCommentRetriage 2026-07-30-08:05 (PR #2612 review — greptile):
        SAY SO WHEN THE FALLBACK FIRES. The legacy pair is the right BEHAVIOUR on a
        resolution failure — this is best-effort re-triage whose failure mode is a
        MISSED re-spec — but swallowing the cause left the one question an operator
        asks unanswerable: "why did my correction not re-trigger planning on a
        renamed board?" The card simply does not re-triage, and the lanes it was
        compared against are invisible.

        DEBUG, not warn, and deliberately: an unresolvable workflow is also the
        ordinary shape for a task with no selection yet, so a warn would fire on
        every such comment add and train people to ignore it. The four sibling
        best-effort logs in this file warn because they describe an action that was
        supposed to happen and did not; this describes a fallback that is frequently
        correct.
        */
        const workflowIr = await resolveWorkflowIrForTask(store, id).catch((err: unknown) => {
          storeLog.debug("Post-comment re-triage planner-lane resolution failed", {
            ...commentContextBase,
            phase: "addComment:planner-lane-resolution",
            fallbackHold: "todo",
            fallbackIntake: "triage",
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        });
        const lifecycle = workflowIr ? resolveLifecycleColumns(workflowIr) : undefined;
        return {
          intake: lifecycle?.intake ?? "triage",
          hold: lifecycle?.hold ?? "todo",
        };
      })()
      : undefined;
    if (retriageColumns && (task.column === retriageColumns.hold || task.column === retriageColumns.intake)) {
      let hasRealPrompt = false;
      try {
        const promptPath = join(store.taskDir(id), "PROMPT.md");
        if (existsSync(promptPath)) {
          const prompt = await readFile(promptPath, "utf-8");
          hasRealPrompt = !isBootstrapPromptStub(prompt, task.id, task.title, task.description);
        }
      } catch (err) {
        storeLog.warn("Best-effort post-comment re-triage prompt-read failed", {
          ...commentContextBase,
          phase: "addComment:retriage-prompt-read",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-14:40 (rebase onto main's extraction):
      Main extracted the two inner column checks into `resolvePostCommentRetriageDecision`,
      which takes `column` and DOES NOT USE IT — the column decision now lives entirely in the
      outer planner-lane gate above, which this branch converts. So the inner half of this
      conversion is dropped as obsolete rather than re-applied on top.

      Worth flagging for that extraction's author: the unused `column` parameter reads as though
      a column decision is still being made there. It is not, and a future reader adding one
      back would silently double-gate.
      */
      const { invalidateApproval: shouldInvalidateAwaitingApproval, retriagePlanned: shouldRetriagePlannedTask } =
        resolvePostCommentRetriageDecision({ column: task.column, status: task.status, hasRealPrompt });

      if (shouldInvalidateAwaitingApproval || shouldRetriagePlannedTask) {
        const phase = shouldInvalidateAwaitingApproval
          ? "addComment:awaiting-approval-invalidation"
          : "addComment:planned-task-retriage";
        const action = shouldInvalidateAwaitingApproval
          ? "User comment invalidated spec approval — task needs re-specification"
          : "User comment requested re-specification of planned task";
        let transitioned = false;

        try {
          await store.updateTask(id, { status: "needs-replan" });
          transitioned = true;
        } catch (err) {
          storeLog.warn("Best-effort post-comment re-triage failed", {
            ...commentContextBase,
            phase,
            stage: "status-update",
            nextStatus: "needs-replan",
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (transitioned) {
          try {
            await store.logEntry(id, action, text, runContext);
          } catch (err) {
            storeLog.warn("Best-effort post-comment re-triage failed", {
              ...commentContextBase,
              phase,
              stage: "post-invalidation-log-entry",
              nextStatus: "needs-replan",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    return task;
  }

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-23:40:
Shared by both document paths so the "is this card archived?" answer cannot differ between the write
guard and the publication guard — one saying yes while the other says no is how a card ends up both
read-only and un-publishable.

FNXC:WorkflowLifecycleColumns 2026-07-31-04:10:
The helper that used to live here now lives in `project-lane-vocabulary.ts` and is imported. It grew a
THIRD caller (`getLiveTaskColumn`, whose sentinel a dozen sites compare against), and three private
copies of one fact is how the disagreement above happens at scale rather than between two functions.
The analysis below is unchanged and still governs the shape.
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-03:35 (#2886 review — greptile P1, "project-wide lanes
misclassify tasks"): THE FINDING IS RIGHT AND THE OBVIOUS FIX IS A WORSE TRADE. Measured, not argued.

The union includes a column if ANY enabled workflow calls it archived, so where two workflows reuse an
id and only one marks it archived, a LIVE card in the other workflow's lane is refused its own
document writes. That is the flat-set mistake this file should not be making, and both callers have
`taskId`, so a keyed answer looks available.

I IMPLEMENTED IT AND REVERTED. Switching to `resolveWorkflowIrForTask(store, taskId)` broke
`archived-document-lanes.pg.test.ts`: a card in a RENAMED archived lane stopped being read-only. The
reason is the one this program keeps hitting from the other side — the per-task resolver needs the
task's own workflow SELECTION, and where none is recorded it degrades to the BUILT-IN ir, whose
archived lane is `archived`. The project union does not need a selection, which is exactly why it
caught the renamed card.

So the two failure modes are not comparable in size:
  - union: a live card in a COLLIDING id loses document writes (needs two workflows reusing one id
    with different traits — a configuration nobody has reported).
  - per-task: EVERY renamed-lane card with no recorded selection silently becomes writable while
    archived, which is the defect this guard exists to prevent and has a passing test.

The correct fix is per-task resolution WITH a project-union fallback when the selection is absent —
narrow when the card can answer, broad when it cannot. That needs the "no selection" case
distinguished from "selection resolved to the default", i.e. the provenance form, at both call sites.
Sized here rather than faked, because swapping one defect for a larger one would have looked like
progress and dropped a guard count.
*/

export async function publishArchivedTaskDocumentAdditionImpl(
  store: TaskStore,
  taskId: string,
  input: ArchivedTaskDocumentAdditionInput,
): Promise<ArchivedTaskDocumentAdditionResult> {
  try {
    validateDocumentKey(input.key);
  } catch {
    throw new Error(`Invalid document key: "${input.key}". Must be 1-64 alphanumeric characters, hyphens, or underscores.`);
  }
  validateArchivedTaskDocumentAddition(input);
  if (!store.backendMode || !store.asyncLayer) {
    throw new ArchivedTaskDocumentPublicationRejectedError(
      "postgres-required",
      store.asyncLayer?.projectId ?? "__legacy_unscoped__",
      taskId,
      input.key,
    );
  }
  /*
  FNXC:ArchivedTaskDocumentPublication 2026-07-20-15:36:
  The dedicated facade deliberately returns the atomic PostgreSQL result directly. Unlike ordinary upsert it emits no task event and performs no citation scan, keeping archived parent, workflow, mission, and scheduler state inert.
  */
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-23:40:
  Resolve the board's archived lanes here — this impl holds the store, the async function does not.

  Keyed on the literal, this rejected a legitimate archived-document publication on any board whose
  archived lane is renamed: `parent-not-archived`, then `archived-state-inconsistent`. A false
  rejection of valid operator work, and one that reads as a data-integrity error rather than a
  lifecycle mismatch. Best-effort: an unresolvable workflow keeps the legacy id.
  */
  return publishArchivedTaskDocumentAdditionAsync(store.asyncLayer, taskId, input, await resolveArchivedLanes(store));
}

export async function upsertTaskDocumentImpl(store: TaskStore, taskId: string, input: TaskDocumentCreateInput): Promise<TaskDocument> {
    try {
      validateDocumentKey(input.key);
    } catch {
      throw new Error(
        `Invalid document key: "${input.key}". Must be 1-64 alphanumeric characters, hyphens, or underscores.`,
      );
    }

    validateTaskDocumentPreconditions(input);

    // FNXC:RuntimeWorkflowAsync 2026-06-24-17:00:
    // Backend mode: delegate the core upsert (revision archive + update) to
    // upsertTaskDocumentAsync. The citation scanning and task:updated emission
    // happen after (best-effort, same as the SQLite path).
        const layer = store.asyncLayer!;
    /* FNXC:WorkflowLifecycleColumns 2026-07-30-23:40: keyed on the literal, an ARCHIVED card's
       documents stayed WRITABLE on any board whose archived lane is renamed. */
    const document = await upsertTaskDocumentAsync(layer, taskId, input, await resolveArchivedLanes(store));
    const task = await store.getTask(taskId);
    store.emit("task:updated", task);
    try {
      const citationInputs = store.scanAndRecordCitations(
        input.content,
        "task_document",
        `document:${taskId}:${input.key}:rev${document.revision}`,
        input.author ?? "user",
        taskId,
        document.updatedAt,
      );
      if (citationInputs.length > 0) {
        void store.recordGoalCitations(citationInputs).catch((err) => {
          severityAuditLog.warn("[fusion] Failed to record goal citations from task document:", err);
        });
      }
    } catch (err) {
      severityAuditLog.warn("[fusion] Failed to scan/record goal citations from task document:", err);
    }
    return document;
}
