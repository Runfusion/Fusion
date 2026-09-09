import { emitBoundedRunAudit } from "../run-audit/emit-bounded-run-audit.js";
/* FNXC:RunAudit 2026-08-20-05:49: FN-9177 bounds optional audit telemetry so a hostile sink cannot alter this lifecycle path. */
/**
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Domain rename from remaining-ops-7: merge-queue peeks, archive/done transitions,
 * comments, artifacts/documents, and related task side-effect helpers.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */

import { TaskStore } from "../store.js";
import { buildPatchnodeEntryInput } from "../board/patchnode.js";
import { appendPatchnodeEntryInTransaction } from "./async/async-patchnode.js";
import {declaresAnyLifecycleTrait, resolveReviewColumns, resolveTaskLifecycleColumns} from "../workflows/workflow-lifecycle-traits.js";
import {resolveWorkflowIrForTask} from "../workflows/workflow-ir-resolver.js";
import {toTaskMoveLanes} from "../workflows/workflow-lifecycle-traits.js";
import { countAgentLogEntries, readAgentLogEntries } from "../agents/agent-log-file-store.js";
import { toJsonNullable } from "../db/db.js";
import { DbTransaction, projectScopeFor, recordRunAuditEventWithinTransaction } from "../postgres/data-layer.js";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { runCommandAsync } from "../process/run-command.js";
import { getStepParser } from "../tasks/step-parsers.js";
import { getTaskMergeBlocker } from "../merge/task-merge.js";
import { resolveRequiredPreMergeStepIds } from "../merge/required-pre-merge-steps.js";
import { deleteTaskDocument as deleteTaskDocumentAsync, getArtifact as getArtifactAsync, getArtifacts as getArtifactsAsync, getLiveTaskColumn, getTaskDocument as getTaskDocumentAsync, getTaskDocumentRevisions as getTaskDocumentRevisionsAsync, listTaskDocuments as listTaskDocumentsAsync, updateArtifactRow as updateArtifactRowAsync } from "./async/async-comments-attachments.js";
import { emitUsageEvent as emitUsageEventAsync, recordPluginActivation as recordPluginActivationAsync } from "./async/async-events.js";
import { enqueueMergeQueue as enqueueMergeQueueAsync, peekMergeQueue as peekMergeQueueAsync, peekMergeQueueHead as peekMergeQueueHeadAsync } from "./async/async-merge-coordination.js";
import { clearCompletionHandoffMarker as clearCompletionHandoffMarkerAsync, getCompletionHandoffMarker as getCompletionHandoffMarkerAsync } from "./async/async-workflow-workitems.js";
import { extractEffectiveWriteScopeFromPrompt } from "../tasks/file-scope-classification.js";
import { ArtifactRow, WorkflowWorkItemRow } from "./row-types.js";
import { AgentLogEntry, Artifact, ArtifactCreateInput, Column, CompletionHandoffMarker, MergeQueueEnqueueOptions, MergeQueueEntry, PluginActivation, PluginActivationInput, RunMutationContext, Task, TaskDocument, TaskDocumentRevision, WorkflowWorkItem, WorkflowWorkItemKind } from "../types.js";
import type { UsageEventInput } from "../tasks/usage-events.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { storeLog } from "../store.js";
import { ARCHIVED_SENTINEL_LANES } from "../project-lane-vocabulary.js";


export function listWorkflowWorkItemsForTaskSyncImpl(store: TaskStore, taskId: string, opts: { kinds?: WorkflowWorkItemKind[] } = {}): WorkflowWorkItem[] {
    const conditions = ["taskId = ?"];
    const params: unknown[] = [taskId];
    if (opts.kinds?.length) {
      conditions.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
      params.push(...opts.kinds);
    }
    const rows = store.db
      .prepare(
        `SELECT *
           FROM workflow_work_items
          WHERE ${conditions.join(" AND ")}
          ORDER BY createdAt ASC, id ASC`,
      )
      .all(...params) as WorkflowWorkItemRow[];
    return rows.map((row) => store.rowToWorkflowWorkItem(row));
}

export async function clearCompletionHandoffAcceptedMarkerImpl(store: TaskStore, taskId: string): Promise<void> {
        const layer = store.asyncLayer!;
    const existing = await getCompletionHandoffMarkerAsync(layer.db, taskId);
    if (!existing) return;
    await clearCompletionHandoffMarkerAsync(layer.db, taskId);
    void emitBoundedRunAudit(store, {
      taskId,
      agentId: "system",
      runId: `completion-handoff-clear:${taskId}:${Date.now()}`,
      domain: "database",
      mutationType: "task:completion-handoff-cleared",
      target: taskId,
      metadata: { taskId, acceptedAt: existing.acceptedAt, source: existing.source },
    });
    return;
}

export async function getCompletionHandoffAcceptedMarkerImpl(store: TaskStore, taskId: string): Promise<CompletionHandoffMarker | null> {
        const layer = store.asyncLayer!;
    const marker = await getCompletionHandoffMarkerAsync(layer.db, taskId);
    return marker as CompletionHandoffMarker | null;
}

export async function recordPluginActivationImpl(store: TaskStore, input: PluginActivationInput): Promise<PluginActivation> {
        const layer = store.asyncLayer!;
    return recordPluginActivationAsync(layer.db, input);
}

export async function enqueueMergeQueueImpl(store: TaskStore, taskId: string, opts: MergeQueueEnqueueOptions = {}): Promise<MergeQueueEntry> {
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:05:
    Merge-queue enqueue is PostgreSQL-only via enqueueMergeQueueAsync (column check, idempotent insert, audit). The SQLite sync arm is deleted (source removed 2026-07-31).
    */
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-02:10:
    Resolve the task's OWN review columns before enqueueing. Without them the in-transaction guard
    falls back to `new Set(["in-review"])` and throws `MergeQueueInvalidColumnError` for a task
    resting in a renamed review lane, which breaks the merger and self-healing re-enqueue paths on
    every custom board. `undefined` on failure is deliberate and matches `moves.ts`: it makes the
    guard fall back to the legacy id rather than to an empty set that matches nothing.
    */
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-15:15 (#2819 review — greptile, "traitless workflows reject re-enqueue"):
    THREE STATES, NOT TWO. `undefined` (unreadable) was already handled. The missing one is an IR that
    resolves but carries NO lifecycle trait on any column: `synthesizeDefaultColumns` upgrades a v1
    graph by emitting the default columns with `traits: []`, so `resolveReviewColumns` returns EMPTY
    while the board's `in-review` column plainly exists and holds the card. Forwarding that empty set
    made the guard match nothing and throw `MergeQueueInvalidColumnError` — the very failure this
    conversion was fixing, moved from custom boards onto every pre-v2 project.

    Only a board that EXPRESSES traits and still has no review lane is answering the question; the
    other two states take the legacy id.
    */
    const reviewIr = await resolveWorkflowIrForTask(store, taskId).catch(() => undefined);
    const reviewColumns = reviewIr && declaresAnyLifecycleTrait(reviewIr)
      ? new Set(resolveReviewColumns(reviewIr))
      : undefined;
    return enqueueMergeQueueAsync(store.asyncLayer!, taskId, opts, undefined, reviewColumns);
}

export function cleanupStaleMergeQueueRowsImpl(store: TaskStore, now: string): void {
    const staleRows = store.db.prepare(`
      SELECT mq.taskId, mq.leasedBy, mq.leaseExpiresAt, t.column
        FROM mergeQueue mq
        LEFT JOIN tasks t ON t.id = mq.taskId
       WHERE t.id IS NULL OR t.column != 'in-review'
    `).all() as Array<{ taskId: string; leasedBy: string | null; leaseExpiresAt: string | null; column: Column | null }>;

    for (const staleRow of staleRows) {
      store.db.prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(staleRow.taskId);
      store.insertRunAuditEventRow({
        taskId: staleRow.taskId,
        domain: "database",
        mutationType: "mergeQueue:auto-cleanup-stale-row",
        target: staleRow.taskId,
        metadata: {
          taskId: staleRow.taskId,
          column: staleRow.column,
          leasedBy: staleRow.leasedBy,
          leaseExpiresAt: staleRow.leaseExpiresAt,
          cleanedAt: now,
          reason: "not-in-review",
        },
      });
    }
}

export async function peekMergeQueueImpl(store: TaskStore): Promise<MergeQueueEntry[]> {
        const layer = store.asyncLayer!;
    return peekMergeQueueAsync(layer);
}

export async function peekMergeQueueHeadImpl(store: TaskStore): Promise<{ taskId: string; leasedBy: string | null; column: Column | null } | null> {
        const layer = store.asyncLayer!;
    const head = await peekMergeQueueHeadAsync(layer);
    // The async helper returns column as string | null (Drizzle text column);
    // cast to the Column union for the public API contract.
    return head ? { ...head, column: head.column as Column | null } : null;
}

export async function parseStepsFromPromptImpl(store: TaskStore, id: string): Promise<import("../types.js").TaskStep[]> {
    const dir = store.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");
    // Step-inversion U12 (KTD-12): delegate to the registry's `step-headings`
    // parser (resolved by id, not a direct import) so the registry path is
    // proven and stays byte-identical to the extracted function. The parser
    // yields `{ name, dependsOn? }`; re-apply the `pending` status here.
    const parser = getStepParser("step-headings");
    if (!parser) {
      throw new Error("Step parser 'step-headings' is not registered");
    }
    return parser.parse(content).steps.map((s) =>
      s.dependsOn
        ? { name: s.name, status: "pending" as const, dependsOn: s.dependsOn }
        : { name: s.name, status: "pending" as const },
    );
}

export async function parseDependenciesFromPromptImpl(store: TaskStore, id: string): Promise<string[]> {
    const dir = store.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");

    // Find the ## Dependencies section.
    // We locate the heading then slice to the next heading (or end of file)
    // to avoid multiline `$` anchor issues with lazy quantifiers.
    const headingMatch = content.match(/^##\s+Dependencies\s*$/m);
    if (!headingMatch) return [];

    const startIdx = headingMatch.index! + headingMatch[0].length;
    const rest = content.slice(startIdx);
    const nextHeading = rest.search(/\n##?\s/);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

    const ids: string[] = [];
    const taskIdRegex = /^-\s+\*\*Task:\*\*\s+([A-Z]+-\d+)/gm;
    let match;
    while ((match = taskIdRegex.exec(section)) !== null) {
      ids.push(match[1]);
    }

    return ids;
}

export async function parseFileScopeFromPromptImpl(store: TaskStore, id: string): Promise<string[]> {
    const dir = store.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");

    return extractEffectiveWriteScopeFromPrompt(content);
}

export async function recordRunAuditEventBackendImpl(store: TaskStore,
    tx: DbTransaction,
    event: {
      domain: string;
      mutationType: string;
      target: string;
      taskId: string;
      agentId: string;
      runId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await recordRunAuditEventWithinTransaction(tx, {
      taskId: event.taskId,
      agentId: event.agentId,
      runId: event.runId,
      domain: event.domain as "database",
      mutationType: event.mutationType,
      target: event.target,
      metadata: event.metadata,
    });
}

export function rewriteLineageChildrenForRemovalImpl(store: TaskStore, parentId: string, childIds: string[]): Task[] {
    const rewrittenChildren: Task[] = [];

    for (const childId of childIds) {
      const childTask = store.readTaskFromDb(childId);
      if (!childTask || childTask.sourceParentTaskId !== parentId) continue;

      const updatedChild: Task = {
        ...childTask,
        sourceParentTaskId: undefined,
        updatedAt: new Date().toISOString(),
      };

      store.db.prepare("UPDATE tasks SET sourceParentTaskId = NULL, updatedAt = ? WHERE id = ?").run(updatedChild.updatedAt, updatedChild.id);
      if (store.isWatching) {
        store.taskCache.set(updatedChild.id, updatedChild);
      }
      rewrittenChildren.push(updatedChild);
    }

    return rewrittenChildren;
}

export async function syncAgentTaskLinkOnReassignmentImpl(store: TaskStore,
    taskId: string,
    previousAgentId: string | undefined,
    newAgentId: string | undefined,
  ): Promise<void> {
    const updatedAt = new Date().toISOString();

    /*
    FNXC:PostgresCutover 2026-07-04-00:00:
    Backend-mode agent-task-link sync: update the agents.taskId column via async Drizzle. Only the dedicated taskId column is authoritative in PG (agent.data jsonb is not read for the link), so the SQLite json_set/json_remove on data is not mirrored.

    FNXC:MultiProjectIsolation 2026-08-11-09:13:
    Runfusion/Fusion#3414 requires reassignment updates to carry project ownership because
    owner/superuser PostgreSQL connections bypass RLS. An unbound store intentionally leaves
    the scope empty for compatibility callers.
    */
        const db = store.asyncLayer!.db;
    const projectId = store.asyncLayer?.projectId;
    if (previousAgentId) {
      await db
        .update(schema.project.agents)
        .set({ taskId: null, updatedAt })
        .where(and(
          eq(schema.project.agents.id, previousAgentId),
          eq(schema.project.agents.taskId, taskId),
          projectScopeFor(schema.project.agents.projectId, projectId),
        ));
    }
    if (newAgentId) {
      await db
        .update(schema.project.agents)
        .set({ taskId, updatedAt })
        .where(and(
          eq(schema.project.agents.id, newAgentId),
          projectScopeFor(schema.project.agents.projectId, projectId),
        ));
    }
    return;
}

export async function runGitCommandImpl(store: TaskStore, command: string, timeoutMs = 10_000) {
    return runCommandAsync(command, {
      cwd: store.rootDir,
      timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
}

export async function clearStaleExecutionStartBranchReferencesImpl(store: TaskStore, deletedBranches: string[], ownerTaskId?: string): Promise<string[]> {
    if (deletedBranches.length === 0) return [];
        /*
    FNXC:PostgresBranchCleanup 2026-07-14-17:30:
    Deleted execution-start branches must be cleared from every other live task in PostgreSQL. Returning an empty safe default leaves durable references to branches that no longer exist and turns later worktree creation into a false hard failure.
    */
    const now = new Date().toISOString();
    const conditions = [
      isNull(schema.project.tasks.deletedAt),
      inArray(schema.project.tasks.executionStartBranch, deletedBranches),
    ];
    if (ownerTaskId) conditions.push(ne(schema.project.tasks.id, ownerTaskId));
    const rows = await store.asyncLayer!.db
      .update(schema.project.tasks)
      .set({ executionStartBranch: null, updatedAt: now })
      .where(and(...conditions))
      .returning({ id: schema.project.tasks.id });
    const clearedIds = rows.map((row) => row.id);
    if (store.isWatching) {
      for (const id of clearedIds) {
        const cached = store.taskCache.get(id);
        if (cached) {
          cached.executionStartBranch = undefined;
          cached.updatedAt = now;
        }
      }
    }
    return clearedIds;
}

export async function moveToDoneImpl(store: TaskStore, task: Task, dir: string): Promise<void> {
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-02-16:10 (fleet: the archive/complete writer):
    THE GUARD, THE WRITE AND THE EVENT are one decision and now share one snapshot. This function writes
    `task.column` DIRECTLY (it is the store's own finaliser, not a moveTask caller), so a literal here is not
    caught by moveTask's unknown-column validation the way every converted call site is — it silently persists
    a column the board does not declare, and then emits `to: "done"` to every listener.

    That makes this one of the few sites where a literal writes bad state rather than failing to act. On a
    renamed board: the already-complete short-circuit never fired (so the finaliser re-ran and re-stamped
    executionCompletedAt), the row was written to `done` instead of the board's completion column, and the
    event told the GitHub tracking poster and the auto-merge handoff about a column that does not exist.

    A workflow that declares columns but NO complete lane refuses rather than inventing one — the distinction
    #2733 settled: a missing field on a resolved struct is an answer, and `?? legacy` discards it.
    */
    const completeLifecycle = await resolveTaskLifecycleColumns(store, task.id);
    const completeColumn = completeLifecycle ? completeLifecycle.complete : "done";
    if (completeColumn === undefined) {
      throw new Error(`Cannot move ${task.id} to a completion column: its workflow declares none`);
    }
    if (task.column === completeColumn) {
      return;
    }

    const fromColumn = task.column;
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-01:10 (unwired-parameter class, cf. #2803):
    THE OUTER QUESTION WAS RESOLVED AND THE INNER ONE WAS NOT — in the same function, four lines apart.
    `completeColumn` above comes from the task's workflow, then this call re-asked with the literal and
    refused: on a renamed board the completion move threw

        Cannot move FN-1 to done: task is in 'checking', must be in 'in-review'

    for a card sitting correctly in its own review lane. `getTaskMergeBlocker`'s own note calls out this
    exact half-conversion shape in `moves.ts`; this is the same shape in a second site it did not cover.

    MEMBERSHIP via `resolveReviewColumns` (mergeOrchestration ∪ mergeBlocker ∪ humanReview), so a board
    splitting those across columns has all of them accepted, unioned with the legacy id because
    `resolveWorkflowIrForTask` degrades to the BUILT-IN IR rather than throwing.
    */
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-14:10 (#2820 review — coderabbit, Major):
    THE LEGACY ID IS A FALLBACK, NOT A MEMBER. My first version pre-seeded `in-review` into the set and
    unioned the resolved lanes on top. That admits a board which declares `in-review` as its WIP column:
    a card mid-implementation would pass the merge-identity check and merge prematurely.

    The legacy id is only correct when the board tells us NOTHING — an empty resolved set, or a
    resolution that threw. A non-empty resolved answer replaces it outright; that is the same
    "unscoped legacy acceptance" the glasses plugin's own review caught, and I reintroduced it here.
    */
    let reviewColumns: ReadonlySet<string> = new Set<string>(["in-review"]);
    let mergeIr: Awaited<ReturnType<typeof resolveWorkflowIrForTask>> | undefined;
    try {
      mergeIr = await resolveWorkflowIrForTask(store, task.id);
      const resolved = mergeIr ? resolveReviewColumns(mergeIr) : [];
      if (resolved.length > 0) reviewColumns = new Set(resolved);
    } catch { /* degraded: the board told us nothing, so the legacy id stands */ }
    const mergeBlocker = getTaskMergeBlocker(task, {
      reviewColumns,
      requiredPreMergeStepIds: mergeIr ? resolveRequiredPreMergeStepIds(mergeIr, task.enabledWorkflowSteps, task) : undefined,
    });
    if (mergeBlocker) {
      throw new Error(`Cannot move ${task.id} to done: ${mergeBlocker}`);
    }

    task.column = completeColumn;
    store.clearDoneTransientFields(task);
    task.columnMovedAt = new Date().toISOString();
    task.updatedAt = task.columnMovedAt;
    if (!task.executionCompletedAt) {
      task.executionCompletedAt = task.columnMovedAt;
    }

    /*
    FNXC:PatchnodeLedger 2026-08-28-12:16:
    Each completion is keyed by this move's columnMovedAt and snapshots its current title and summary. The next move overwrites that occurrence evidence, so this insert belongs inside the task-row transaction and intentionally fails the move if it cannot commit; the already-complete return above prevents duplicate delivery writes.

    FNXC:PatchnodeLedger 2026-08-28-13:35:
    Completion capture requires the store's real project partition. An unbound writer must fail this transaction instead of manufacturing a legacy project id whose entry the project-scoped feed can never read.
    */
    await store.atomicWriteTaskJson(dir, task, {
      withinTransaction: async (tx) => {
        await appendPatchnodeEntryInTransaction(
          tx,
          store.asyncLayer!.projectId ?? "",
          buildPatchnodeEntryInput(task, "completed", task.columnMovedAt!),
        );
      },
    });

    // Update cache if watcher is active
    if (store.isWatching) store.taskCache.set(task.id, { ...task });

    /*
    FNXC:WorkflowEvents 2026-07-31-00:40 (fleet):
    Carry the resolved lanes, like the main move path in `moves.ts`. Listeners read `task:moved`
    synchronously and cannot resolve for themselves, so an emit WITHOUT lanes hands every consumer
    its legacy fallback — which on a renamed board is the wrong answer, not a missing one.

    Concretely: the executor's archive branch releases the task's active-session registry entry, and
    that entry is what blocks a SUCCESSOR task from acquiring the same path. Emitting this transition
    lane-less left that leak reachable through this path even after the listener itself was fixed.
    */
    const movedLanes = toTaskMoveLanes(await resolveWorkflowIrForTask(store, task.id).catch(() => undefined));
    /* FNXC:WorkflowEvents 2026-08-22-00:13: an unresolved payload is unknown; retain a warm real cache answer until its TTL expires. */
      if (movedLanes) store.laneCache.set(task.id, movedLanes);
    store.emit("task:moved", { task, from: fromColumn, to: completeColumn as Column, source: "engine", lanes: movedLanes });
}

export function clearDoneTransientFieldsImpl(store: TaskStore, task: Task): boolean {
    const changed = task.status !== undefined
      || task.error !== undefined
      || task.worktree !== undefined
      || task.blockedBy !== undefined
      || task.overlapBlockedBy !== undefined
      || task.recoveryRetryCount !== undefined
      || task.sessionContentionHoldCount !== undefined
      || task.sessionContentionWaitReason !== undefined
      || task.nextRecoveryAt !== undefined
      || task.paused !== undefined
      || task.userPaused !== undefined
      || task.pausedByAgentId !== undefined
      || task.pausedReason !== undefined;

    task.status = undefined;
    task.error = undefined;
    task.worktree = undefined;
    task.blockedBy = undefined;
    task.overlapBlockedBy = undefined;
    task.recoveryRetryCount = undefined;
    task.sessionContentionHoldCount = 0;
    task.sessionContentionWaitReason = undefined;
    task.nextRecoveryAt = undefined;
    task.paused = undefined;
    task.userPaused = undefined;
    task.pausedByAgentId = undefined;
    task.pausedReason = undefined;

    return changed;
}

export function stopWatchingImpl(store: TaskStore): void {
    if (store.watcher) {
      store.watcher.close();
      store.watcher = null;
    }
    for (const timer of store.debounceTimers.values()) {
      clearTimeout(timer);
    }
    store.debounceTimers.clear();
    store.taskCache.clear();
    store.recentlyWritten.clear();
    store.clearStartupSlimListMemo();
}

export async function getAttachmentImpl(store: TaskStore,
    id: string,
    filename: string,
  ): Promise<{ path: string; mimeType: string }> {
    const dir = store.taskDir(id);
    const task = await store.readTaskJson(dir);
    const attachment = task.attachments?.find((a) => a.filename === filename);
    if (!attachment) {
      const err: NodeJS.ErrnoException = new Error(
        `Attachment '${filename}' not found on task ${id}`,
      );
      err.code = "ENOENT";
      throw err;
    }
    return {
      path: join(dir, "attachments", filename),
      mimeType: attachment.mimeType,
    };
}

export async function emitUsageEventImpl(store: TaskStore, event: UsageEventInput): Promise<boolean> {
        const layer = store.asyncLayer!;
    return emitUsageEventAsync(layer.db, layer.projectId ?? "", event);
}

export async function addSteeringCommentImpl(store: TaskStore, id: string, text: string, author: "user" | "agent" = "user", runContext?: RunMutationContext): Promise<Task> {
    // Write to unified comments (skip refinement — steering is for agent injection, not follow-up tasks)
    const task = await store.addComment(id, text, author, { skipRefinement: true }, runContext);

    // Also write to steeringComments so the executor's real-time injection listener can detect new entries
    const updated = await store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const currentTask = await store.readTaskJson(dir);

      const steeringComment: import("../types.js").SteeringComment = {
        id: task.comments![task.comments!.length - 1].id,
        text,
        createdAt: new Date().toISOString(),
        author,
      };

      if (!currentTask.steeringComments) {
        currentTask.steeringComments = [];
      }
      currentTask.steeringComments.push(steeringComment);
      currentTask.updatedAt = new Date().toISOString();

      await store.atomicWriteTaskJson(dir, currentTask);
      if (store.isWatching) store.taskCache.set(id, { ...currentTask });

      store.emit("task:updated", currentTask);
      return currentTask;
    });

    return updated;
}

export async function updateTaskCommentImpl(store: TaskStore, id: string, commentId: string, text: string): Promise<Task> {
    {
      const layer = store.asyncLayer!;
      const state = await getLiveTaskColumn(layer.db, id, layer.projectId, ARCHIVED_SENTINEL_LANES);
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
      if (state === "archived") throw new Error(`Task ${id} is deleted or historical — comments are read-only`);
      if (state === null) throw new Error(`Task ${id} not found`);
    }
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const comments = task.comments || [];
      const comment = comments.find((entry) => entry.id === commentId);

      if (!comment) {
        throw new Error(`Comment ${commentId} not found on task ${id}`);
      }

      comment.text = text;
      comment.updatedAt = new Date().toISOString();
      task.comments = comments;
      task.updatedAt = comment.updatedAt;
      task.log.push({
        timestamp: task.updatedAt,
        action: "Comment updated",
      });

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });

      store.emit("task:updated", task);
      return task;
    });
}

export async function deleteTaskCommentImpl(store: TaskStore, id: string, commentId: string): Promise<Task> {
    {
      const layer = store.asyncLayer!;
      const state = await getLiveTaskColumn(layer.db, id, layer.projectId, ARCHIVED_SENTINEL_LANES);
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
      if (state === "archived") throw new Error(`Task ${id} is deleted or historical — comments are read-only`);
      if (state === null) throw new Error(`Task ${id} not found`);
    }
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const currentComments = task.comments || [];
      const nextComments = currentComments.filter((entry) => entry.id !== commentId);

      if (nextComments.length === currentComments.length) {
        throw new Error(`Comment ${commentId} not found on task ${id}`);
      }

      task.comments = nextComments.length > 0 ? nextComments : undefined;
      task.updatedAt = new Date().toISOString();
      task.log.push({
        timestamp: task.updatedAt,
        action: "Comment deleted",
      });

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });

      store.emit("task:updated", task);
      return task;
    });
}

export async function writeArtifactDataImpl(store: TaskStore, input: ArtifactCreateInput, id: string): Promise<{ uri?: string; sizeBytes?: number; absolutePath?: string }> {
    if (!input.data) {
      return {};
    }

    const storedName = TaskStore.artifactStoredName(id, input.title);
    if (input.taskId) {
      const artifactDir = join(store.taskDir(input.taskId), "artifacts");
      await mkdir(artifactDir, { recursive: true });
      const absolutePath = join(artifactDir, storedName);
      await writeFile(absolutePath, input.data);
      return { uri: `artifacts/${storedName}`, sizeBytes: input.data.length, absolutePath };
    }

    const artifactDir = store.artifactRegistryDir();
    await mkdir(artifactDir, { recursive: true });
    const absolutePath = join(artifactDir, storedName);
    await writeFile(absolutePath, input.data);
    return { uri: `artifacts/${storedName}`, sizeBytes: input.data.length, absolutePath };
}

export function insertArtifactRowImpl(store: TaskStore, input: ArtifactCreateInput, id: string, now: string, stored: { uri?: string; sizeBytes?: number }): Artifact {
    store.db.prepare(
      `INSERT INTO artifacts (
        id, type, title, description, mimeType, sizeBytes, uri, content, authorId, authorType, taskId, metadata, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.type,
      input.title,
      input.description ?? null,
      input.mimeType ?? null,
      stored.sizeBytes ?? input.sizeBytes ?? null,
      stored.uri ?? input.uri ?? null,
      input.data ? null : input.content ?? null,
      input.authorId,
      input.authorType,
      input.taskId ?? null,
      toJsonNullable(input.metadata),
      now,
      now,
    );

    const row = store.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    if (!row) {
      throw new Error(`Failed to register artifact ${id}`);
    }
    return store.rowToArtifact(row);
}

export async function getArtifactImpl(store: TaskStore, id: string): Promise<Artifact | null> {
        const layer = store.asyncLayer!;
    return getArtifactAsync(layer.db, id, layer.projectId);
}

/**
 * FNXC:ArtifactRegistry 2026-07-10-15:20 (merge port from main):
 * The dashboard Artifacts view lets operators edit any inline-content document artifact in place
 * (title/description/content). Binary artifacts (rows with a uri) keep content non-editable because
 * their payload lives on disk; only metadata edits are allowed there. Archived-task artifacts stay
 * read-only, mirroring registerArtifact. Emits `artifact:updated` and bumps lastModified so open
 * artifact lists live-refresh.
 */
export async function updateArtifactImpl(store: TaskStore, id: string, updates: { title?: string; description?: string; content?: string }): Promise<Artifact> {
        const layer = store.asyncLayer!;
    const updated = await updateArtifactRowAsync(layer, id, updates, ARCHIVED_SENTINEL_LANES);
    store.emit("artifact:updated", updated);
    return updated;
}

export async function getArtifactsImpl(store: TaskStore, taskId: string): Promise<Artifact[]> {
        const layer = store.asyncLayer!;
    return getArtifactsAsync(layer.db, taskId, layer.projectId, ARCHIVED_SENTINEL_LANES);
}

export async function getTaskDocumentsImpl(store: TaskStore, taskId: string): Promise<TaskDocument[]> {
        const layer = store.asyncLayer!;
    return listTaskDocumentsAsync(layer.db, taskId, layer.projectId, ARCHIVED_SENTINEL_LANES);
}

export async function getTaskDocumentImpl(store: TaskStore, taskId: string, key: string): Promise<TaskDocument | null> {
        const layer = store.asyncLayer!;
    return getTaskDocumentAsync(layer.db, taskId, key, layer.projectId, ARCHIVED_SENTINEL_LANES);
}

export async function getTaskDocumentRevisionsImpl(store: TaskStore,
    taskId: string,
    key: string,
    options?: { limit?: number },
  ): Promise<TaskDocumentRevision[]> {
    /*
    FNXC:PostgresCutover 2026-07-04:
    Backend-mode read of task_document_revisions via the async Drizzle helper.
    The helper returns revisions newest-first by createdAt; the sync SQLite
    path orders by revision DESC, so we re-sort by revision descending in JS
    to preserve that ordering exactly, then apply the optional LIMIT.
    */
        const layer = store.asyncLayer!;
    const rows = await getTaskDocumentRevisionsAsync(layer.db, taskId, key, layer.projectId, ARCHIVED_SENTINEL_LANES);
    const sorted = [...rows].sort((a, b) => b.revision - a.revision);
    const mapped = sorted.map((row) => store.rowToTaskDocumentRevision(row));
    return options?.limit !== undefined ? mapped.slice(0, Math.max(0, options.limit)) : mapped;
}

export async function deleteTaskDocumentImpl(store: TaskStore, taskId: string, key: string): Promise<void> {
    /*
    FNXC:PostgresCutover 2026-07-04:
    Backend-mode delete via the async Drizzle helper (deleteTaskDocument in
    async-comments-attachments.ts). The helper verifies existence (throwing the
    same "not found" error) and removes revisions + document in one transaction.
    The post-delete task:updated emit mirrors the SQLite path; getTask returns
    only live tasks so a present task implies deletedAt == null.
    */
        const layer = store.asyncLayer!;
    await deleteTaskDocumentAsync(layer, taskId, key, ARCHIVED_SENTINEL_LANES);
    const task = await store.getTask(taskId);
    if (task) {
      store.emit("task:updated", task);
    }
    return;
}

export function resolvePrimaryPrInfoImpl(store: TaskStore, prInfos: import("../types.js").PrInfo[]): import("../types.js").PrInfo | undefined {
    // Primary selection rule: prefer the most-recently-updated open PR; if none are open,
    // fall back to the first linked PR for stable back-compat rendering.
    const openPrs = prInfos.filter((entry) => entry.status === "open");
    if (openPrs.length === 0) return prInfos[0];
    const sorted = [...openPrs].sort((a, b) => {
      const aTs = Date.parse(a.lastCheckedAt ?? a.lastCommentAt ?? "");
      const bTs = Date.parse(b.lastCheckedAt ?? b.lastCommentAt ?? "");
      if (Number.isFinite(aTs) && Number.isFinite(bTs)) return bTs - aTs;
      if (Number.isFinite(aTs)) return -1;
      if (Number.isFinite(bTs)) return 1;
      return 0;
    });
    return sorted[0] ?? prInfos[0];
}

export function upsertPrInfoByNumberImpl(store: TaskStore, prInfos: import("../types.js").PrInfo[], prInfo: import("../types.js").PrInfo): import("../types.js").PrInfo[] {
    const idx = prInfos.findIndex((entry) => entry.number === prInfo.number);
    if (idx >= 0) {
      const next = [...prInfos];
      next[idx] = { ...next[idx], ...prInfo };
      return next;
    }
    return [prInfo, ...prInfos];
}

export async function addPrInfoImpl(store: TaskStore, id: string, prInfo: import("../types.js").PrInfo): Promise<Task | undefined> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      let prInfos = store.getTaskPrInfos(task);
      const existingIndex = prInfos.findIndex((entry) => entry.number === prInfo.number);
      if (existingIndex >= 0) {
        prInfos[existingIndex] = { ...prInfos[existingIndex], ...prInfo };
      } else {
        prInfos = [prInfo, ...prInfos];
      }
      task.prInfos = prInfos;
      task.prInfo = store.resolvePrimaryPrInfo(prInfos);
      task.updatedAt = new Date().toISOString();
      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);
      return task;
    });
}

export async function updatePrInfoByNumberImpl(store: TaskStore, id: string, number: number, patch: Partial<import("../types.js").PrInfo>): Promise<Task | undefined> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const prInfos = store.getTaskPrInfos(task);
      const index = prInfos.findIndex((entry) => entry.number === number);
      if (index < 0) {
        storeLog.warn(`[store] updatePrInfoByNumber: PR #${number} not found for ${id}`);
        return task;
      }
      prInfos[index] = { ...prInfos[index], ...patch };
      task.prInfos = prInfos;
      task.prInfo = store.resolvePrimaryPrInfo(prInfos);
      task.updatedAt = new Date().toISOString();
      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);
      return task;
    });
}

export async function removePrInfoByNumberImpl(store: TaskStore, id: string, number: number): Promise<Task | undefined> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const prInfos = store.getTaskPrInfos(task).filter((entry) => entry.number !== number);
      if ((task.prInfos ?? []).length === prInfos.length && task.prInfo?.number !== number) {
        storeLog.warn(`[store] removePrInfoByNumber: PR #${number} not found for ${id}`);
        return task;
      }
      task.prInfos = prInfos.length > 0 ? prInfos : undefined;
      task.prInfo = store.resolvePrimaryPrInfo(prInfos);
      task.updatedAt = new Date().toISOString();
      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);
      return task;
    });
}

export async function updateGithubTrackingImpl(store: TaskStore,
    id: string,
    tracking: import("../types.js").TaskGithubTracking | null,
  ): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const nextTracking = tracking ?? undefined;
      const previousTracking = task.githubTracking;

      if (JSON.stringify(previousTracking ?? null) === JSON.stringify(nextTracking ?? null)) {
        return task;
      }

      task.githubTracking = nextTracking;
      task.log.push({
        timestamp: new Date().toISOString(),
        action: tracking?.enabled === false ? "GitHub tracking disabled" : "GitHub tracking enabled",
      });
      task.updatedAt = new Date().toISOString();

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);
      return task;
    });
}

export async function linkGithubIssueImpl(store: TaskStore,
    id: string,
    issue: import("../types.js").TaskGithubTrackedIssue,
  ): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const previous = task.githubTracking ?? {};

      const nextTracking: import("../types.js").TaskGithubTracking = {
        ...previous,
        issue,
        enabled: previous.enabled ?? true,
      };

      if (JSON.stringify(previous) === JSON.stringify(nextTracking)) {
        return task;
      }

      task.githubTracking = nextTracking;
      task.log.push({
        timestamp: new Date().toISOString(),
        action: "GitHub issue linked",
        outcome: `${issue.owner}/${issue.repo}#${issue.number}`,
      });
      task.updatedAt = new Date().toISOString();

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);
      return task;
    });
}

/*
FNXC:AgentLogRead 2026-07-16-00:00:
Issue #2149 requires read-only type filtering to reach the file store before pagination so task-chat log pages and their totals are coherent.
*/
export async function getAgentLogsImpl(store: TaskStore,
    taskId: string,
    options?: { limit?: number; offset?: number; type?: AgentLogEntry["type"] },
  ): Promise<AgentLogEntry[]> {
    // Ensure buffered entries are visible before reading.
    store.flushAgentLogBuffer();
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-15:45:
    // Backend mode: skip the sync readTaskFromDb deleted-check.
    
    const limit = options?.limit !== undefined
      ? (Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 0)
      : undefined;
    const offset = options?.offset !== undefined
      ? (Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset)) : 0)
      : 0;

    if (limit === 0) return [];

    return readAgentLogEntries(store.taskDir(taskId), { limit, offset, type: options?.type }).map(
      ({ lineNo: _lineNo, sourceRef: _sourceRef, ...entry }) => entry,
    );
}

export async function getAgentLogCountImpl(
  store: TaskStore,
  taskId: string,
  options?: { type?: AgentLogEntry["type"] },
): Promise<number> {
    store.flushAgentLogBuffer();
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-15:45:
    // Backend mode: skip the sync readTaskFromDb check. The agent log file
    // is read from the file system regardless; the deleted-task check is a
    // best-effort optimization that is not critical for the archive path.
    
    return countAgentLogEntries(store.taskDir(taskId), { type: options?.type });
}
