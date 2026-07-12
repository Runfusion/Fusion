/**
 * remaining-ops-1 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog, WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX, WORKFLOW_MOVE_POLICY_TIMEOUT_MS} from "../store.js";
import {TransitionRejectionError} from "./errors.js";
import * as schema from "../postgres/schema/index.js";
import {randomUUID} from "node:crypto";
import {and, eq, isNull, ne, or, sql} from "drizzle-orm";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import type {Task, ColumnId, CheckoutClaimPrecondition, ActivityLogEntry, RunAuditEvent, RunAuditEventInput, RunAuditEventFilter, GoalCitation, GoalCitationFilter} from "../types.js";
import {parseWorkflowIr, serializeWorkflowIr, downgradeIrToV1IfPure} from "../workflow-ir.js";
import {makeTransitionRejection} from "../transition-types.js";
import {getWorkflowExtensionRegistry} from "../workflow-extension-registry.js";
import type {WorkflowMovePolicyInput} from "../workflow-extension-types.js";
import "../builtin-traits.js";
import type {WorkflowDefinition, WorkflowDefinitionInput} from "../workflow-definition-types.js";
import {WORKFLOW_PARITY_OBSERVED_MUTATION, WORKFLOW_PARITY_DRIFT_MUTATION, type WorkflowParityDiff, type WorkflowParitySummary} from "../workflow-parity.js";
import {normalizeTaskPriority} from "../task-priority.js";
import {toJsonNullable} from "../db.js";
import type {AsyncDataLayer, DbTransaction} from "../postgres/data-layer.js";
import {recordRunAuditEventWithinTransaction} from "../postgres/data-layer.js";
import {EvalStore} from "../eval-store.js";
import {AsyncEvalStore} from "../async-eval-store.js";
import {BackwardCompat, ProjectRequiredError} from "../migration.js";
import {CentralCore} from "../central-core.js";
import {extractTaskIdTokens, normalizeTitleForTaskId} from "../task-title-id-drift.js";
import {generateTaskLineageId} from "../task-lineage.js";
import {sanitizeFileScopeInPromptContent} from "../task-store/file-scope.js";
import {type TaskRow} from "../task-store/persistence.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {nextWorkflowDefinitionIdAsyncImpl} from "../task-store/remaining-ops-8.js";
import {upsertTaskRowInTransaction, buildTaskInsertValues} from "../task-store/async-persistence.js";
import {readTaskRowInTransaction} from "../task-store/async-persistence.js";
import {recordActivityLogEntry as recordActivityLogEntryAsync} from "../task-store/async-audit.js";
import {recordRunAuditEvent as recordRunAuditEventAsync} from "../postgres/data-layer.js";
import {listGoalCitations as listGoalCitationsAsync} from "../task-store/async-events.js";
import type {GoalCitationRow, RunAuditEventRow} from "../task-store/row-types.js";

export async function getOrCreateForProjectImpl(store: typeof TaskStore, projectId?: string, centralCore?: CentralCore, globalSettingsDir?: string, asyncLayer?: AsyncDataLayer,): Promise<TaskStore> {
    const central = centralCore ?? new CentralCore();
    let initializedHere = false;

    if (!centralCore) {
      await central.init();
      initializedHere = true;
    }

    try {
      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext(process.cwd(), projectId);
      const resolvedGlobalSettingsDir = globalSettingsDir
        ?? (process.env.VITEST === "true"
          ? join(context.workingDirectory, ".fusion-global-settings")
          : undefined);
      const store = new TaskStore(
        context.workingDirectory,
        resolvedGlobalSettingsDir,
        asyncLayer ? { asyncLayer } : undefined,
      );
      await store.init();
      return store;
    } catch (error) {
      if (error instanceof ProjectRequiredError) {
        if (projectId) {
          throw new Error(`Project "${projectId}" not found`);
        }
        throw new Error(error.message);
      }
      throw error;
    } finally {
      if (initializedHere) {
        await central.close();
      }
    }
  }

export async function listGoalCitationsImpl(store: TaskStore, filter: GoalCitationFilter = {}): Promise<GoalCitation[]> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return listGoalCitationsAsync(layer.db, filter);
    }
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.goalId) {
      clauses.push("goalId = ?");
      params.push(filter.goalId);
    }
    if (filter.agentId) {
      clauses.push("agentId = ?");
      params.push(filter.agentId);
    }
    if (filter.taskId) {
      clauses.push("taskId = ?");
      params.push(filter.taskId);
    }
    if (filter.surface) {
      clauses.push("surface = ?");
      params.push(filter.surface);
    }
    if (filter.startTime) {
      clauses.push("timestamp >= ?");
      params.push(filter.startTime);
    }
    if (filter.endTime) {
      clauses.push("timestamp <= ?");
      params.push(filter.endTime);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));

    const rows = store.db
      .prepare(
        `SELECT * FROM goal_citations ${where} ORDER BY timestamp DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit) as GoalCitationRow[];

    return rows.map((row) => store.rowToGoalCitation(row));
  }

export async function atomicWriteTaskJsonWithAuditImpl(store: TaskStore, dir: string, task: Task, auditInput?: RunAuditEventInput,): Promise<void> {
    const id = store.getTaskIdFromDir(dir);
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:10:
    // Backend mode: upsert the task row + audit event in one async Drizzle
    // transaction (upsertTaskRowInTransaction + recordRunAuditEventWithinTransaction).
    // This preserves the atomicity invariant: the audit row commits or rolls
    // back with the task mutation.
    //
    // FNXC:SoftDeleteResurrectionGuard 2026-06-26:
    // P0 fix (review #7): the backend branch previously blind-upserted the
    // row with no deletedAt re-read, so a write racing a soft-delete would
    // silently resurrect the tombstoned task (R7 / VAL-DATA-005/006). The
    // sync branch enforces this via patchTaskRowInTransaction + the
    // throwSoftDeletedWriteBlocked guard. The backend branch now re-reads the
    // existing row (includeDeleted) inside the same transaction; if deletedAt
    // is set it throws TaskDeletedError (after recording the resurrection-
    // blocked audit event) instead of upserting.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const existingRow = await layer.transactionImmediate(async (tx) => {
        const row = await readTaskRowInTransaction(tx, id, { includeDeleted: true });
        if (row && row.deletedAt != null) {
          return { deletedAt: row.deletedAt as string };
        }
        /*
        FNXC:PostgresCutover 2026-07-10:
        Changed-columns write (parity with sqlite's patchTaskRowInTransaction):
        a full-row upsert from the caller's snapshot silently clobbered any
        column another writer committed since the caller's read — the
        lost-update class behind triage's `status` clear never sticking. Only
        an absent row falls back to the full upsert (create-recovery).
        */
        if (row) {
          const existing = store.pgRowToTaskRow(row);
          const changedColumns = store.getChangedTaskColumns(existing, task);
          if (changedColumns.size > 0) {
            const context = store.createTaskPersistSerializationContext(task, existing);
            const allValues = buildTaskInsertValues(task as unknown as Record<string, unknown>, context);
            const setValues: Record<string, unknown> = { updatedAt: task.updatedAt };
            for (const column of changedColumns) {
              if (column === "id") continue;
              setValues[column as string] = allValues[column as string];
            }
            await tx
              .update(schema.project.tasks)
              .set(setValues as never)
              .where(eq(schema.project.tasks.id, id));
          }
        } else {
          // FNXC:MultiProjectIsolation 2026-07-10: preserve the bound projectId partition key.
          const context = store.createTaskPersistSerializationContext(task);
          await upsertTaskRowInTransaction(tx, task as unknown as Record<string, unknown>, context, layer.projectId);
        }
        if (auditInput) {
          await recordRunAuditEventWithinTransaction(tx, auditInput);
        }
        return undefined;
      });
      if (existingRow?.deletedAt) {
        store.throwSoftDeletedWriteBlocked(id, existingRow.deletedAt, auditInput?.mutationType ?? "atomicWriteTaskJsonWithAudit", {
          agentId: auditInput?.agentId,
          runId: auditInput?.runId,
          timestamp: auditInput?.timestamp,
        });
      }
      await store.writeTaskJsonFile(dir, task);
      return;
    }
    let result: { deletedAt?: string; current?: Task } | undefined;
    store.db.transactionImmediate(() => {
      const existingRow = store.readTaskRowFromDb(id, { includeDeleted: true });
      const changedColumns = existingRow && existingRow.deletedAt == null
        ? store.getChangedTaskColumns(existingRow, task)
        : new Set<keyof TaskRow>();
      result = store.patchTaskRowInTransaction(id, task, changedColumns, existingRow);
      if (result?.deletedAt) return;

      if (auditInput) {
        store.insertRunAuditEventRow(auditInput);
      }
    });
    if (result?.deletedAt) {
      store.throwSoftDeletedWriteBlocked(id, result.deletedAt, auditInput?.mutationType ?? "atomicWriteTaskJsonWithAudit", {
        agentId: auditInput?.agentId,
        runId: auditInput?.runId,
        timestamp: auditInput?.timestamp,
      });
    }

    await store.writeTaskJsonFile(dir, result?.current ?? task);
  }

export async function duplicateTaskImpl(store: TaskStore, id: string): Promise<Task> {
    const sourceTask = await store.getTask(id);
    const now = new Date().toISOString();

    return store.createTaskWithDistributedReservation({ description: sourceTask.description }, {
      createTaskWithId: async (newId) => {
        // FN-5077: duplicated drift-stripped fragments may normalize to null and should remain unset.
        const normalizedTitle = normalizeTitleForTaskId(sourceTask.title, newId);
        if (normalizedTitle.changed) {
          const removed = extractTaskIdTokens(sourceTask.title ?? "").filter((token) => token !== newId.toUpperCase());
          storeLog.log(`[title-id-drift] normalized title for ${newId}: removed=[${removed.join(",")}]`);
        }
        const newTask: Task = {
          id: newId,
          lineageId: generateTaskLineageId(),
          title: normalizedTitle.title ?? undefined,
          description: `${sourceTask.description}\n\n(Duplicated from ${id})`,
          priority: normalizeTaskPriority(sourceTask.priority),
          column: "triage",
          modelPresetId: sourceTask.modelPresetId,
          sourceType: "task_duplicate",
          sourceParentTaskId: id,
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [{ timestamp: now, action: `Duplicated from ${id}` }],
          columnMovedAt: now,
          createdAt: now,
          updatedAt: now,
          baseBranch: sourceTask.baseBranch,
        };

        await store.maybeResolveTombstonedTaskId(newId, {}, "duplicateTask");
        await store.assertTaskIdAvailable(newId);

        const newDir = store.taskDir(newId);
        await store.atomicCreateTaskJson(newDir, newTask, "duplicateTask");
        const sanitizedPrompt = sanitizeFileScopeInPromptContent(sourceTask.prompt);
        if (sanitizedPrompt.dropped.length > 0) {
          storeLog.log(`[file-scope-sanitize] duplicate ${newId} from ${id}: dropped=[${sanitizedPrompt.dropped.join(",")}]`);
        }
        await mkdir(newDir, { recursive: true });
        await writeFile(join(newDir, "PROMPT.md"), sanitizedPrompt.sanitized);

        if (store.isWatching) store.taskCache.set(newId, { ...newTask });
        store.emit("task:created", newTask);
        await store.invokeTaskCreatedHook(newTask);
        return newTask;
      },
    });
  }

export async function listStrandedRefinementsImpl(store: TaskStore, options?: { freshnessThresholdMs?: number; }): Promise<Array<{ task: Task; reasons: Array<"untriaged-stale" | "awaiting-approval" | "failed" | "stuck-killed" | "recovery-backoff">; nextRecoveryAt?: string; ageMs: number; }>> {
    /*
    FNXC:PostgresCutover 2026-07-04-00:00:
    Backend-mode: async Drizzle SELECT on project.tasks WHERE sourceType='task_refine'
    AND column='triage' AND deletedAt IS NULL. The classification logic below is pure
    computation and runs identically in both backends.
    */
    const defaultFreshnessThresholdMs = 10 * 60 * 1000;
    const requestedThresholdMs = options?.freshnessThresholdMs;
    const freshnessThresholdMs = Number.isFinite(requestedThresholdMs) && (requestedThresholdMs ?? 0) >= 0
      ? requestedThresholdMs as number
      : defaultFreshnessThresholdMs;

    let rows: TaskRow[];
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const pgRows = await layer.db.select()
        .from(schema.project.tasks)
        .where(and(
          isNull(schema.project.tasks.deletedAt),
          eq(schema.project.tasks.sourceType, 'task_refine'),
          eq(schema.project.tasks.column, 'triage'),
        ))
        .orderBy(schema.project.tasks.createdAt);
      rows = pgRows.map((r) => store.pgRowToTaskRow(r as Record<string, unknown>)) as unknown as TaskRow[];
    } else {
      const selectClause = store.getTaskSelectClause(false);
      rows = store.db.prepare(
        `SELECT ${selectClause} FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND "sourceType" = 'task_refine' AND "column" = 'triage' ORDER BY createdAt ASC`,
      ).all() as unknown as TaskRow[];
    }

    const now = Date.now();
    const stranded: Array<{
      task: Task;
      reasons: Array<"untriaged-stale" | "awaiting-approval" | "failed" | "stuck-killed" | "recovery-backoff">;
      nextRecoveryAt?: string;
      ageMs: number;
    }> = [];

    for (const row of rows) {
      const task = store.rowToTask(row);
      if (task.paused) {
        continue;
      }

      const reasons: Array<"untriaged-stale" | "awaiting-approval" | "failed" | "stuck-killed" | "recovery-backoff"> = [];
      const createdAtMs = Date.parse(task.createdAt);
      const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, now - createdAtMs) : 0;

      if (task.status === undefined && ageMs > freshnessThresholdMs) {
        reasons.push("untriaged-stale");
      }
      if (task.status === "awaiting-approval") {
        reasons.push("awaiting-approval");
      }
      if (task.status === "failed") {
        reasons.push("failed");
      }
      if (task.status === "stuck-killed") {
        reasons.push("stuck-killed");
      }
      if (task.nextRecoveryAt) {
        const nextRecoveryAtMs = Date.parse(task.nextRecoveryAt);
        if (Number.isFinite(nextRecoveryAtMs) && nextRecoveryAtMs > now) {
          reasons.push("recovery-backoff");
        }
      }

      if (reasons.length > 0) {
        stranded.push({
          task,
          reasons,
          nextRecoveryAt: task.nextRecoveryAt,
          ageMs,
        });
      }
    }

    return stranded;
  }

export async function tryClaimCheckoutImpl(store: TaskStore, taskId: string, claim: { agentId: string; nodeId: string; runId: string | null; leaseEpoch: number; renewedAt: string; }, precondition: CheckoutClaimPrecondition,): Promise<{ ok: true; task: Task } | { ok: false; reason: "row_not_found" | "precondition_failed"; current: Task | null }> {
    const current = await store.getTask(taskId);
    if (!current) {
      return { ok: false, reason: "row_not_found", current: null };
    }

    const updateResult = store.db.prepare(`
      UPDATE tasks
      SET
        checkedOutBy = ?,
        checkedOutAt = COALESCE(checkedOutAt, ?),
        checkoutNodeId = ?,
        checkoutRunId = ?,
        checkoutLeaseRenewedAt = ?,
        checkoutLeaseEpoch = ?
      WHERE id = ?
        AND "deletedAt" IS NULL
        AND COALESCE(checkedOutBy, '') = COALESCE(?, '')
        AND COALESCE(checkoutNodeId, '') = COALESCE(?, '')
        AND COALESCE(checkoutLeaseEpoch, 0) = COALESCE(?, 0)
    `).run(
      claim.agentId,
      new Date().toISOString(),
      claim.nodeId,
      claim.runId,
      claim.renewedAt,
      claim.leaseEpoch,
      taskId,
      precondition.expectedCheckedOutBy ?? null,
      precondition.expectedNodeId ?? null,
      precondition.expectedLeaseEpoch ?? 0,
    ) as { changes: number };

    const post = await store.getTask(taskId);
    if (updateResult.changes === 0) {
      return { ok: false, reason: "precondition_failed", current: post };
    }

    if (!post) {
      return { ok: false, reason: "row_not_found", current: null };
    }

    return { ok: true, task: post };
  }

export async function evaluateWorkflowMovePoliciesImpl(store: TaskStore, input: WorkflowMovePolicyInput): Promise<void> {
    const policies = getWorkflowExtensionRegistry().list("move-policy");
    for (const definition of policies) {
      const extension = definition.extension;
      if (definition.degraded || extension.kind !== "move-policy" || !extension.evaluate) continue;

      let decision: Awaited<ReturnType<NonNullable<typeof extension.evaluate>>>;
      try {
        decision = await new Promise<Awaited<ReturnType<NonNullable<typeof extension.evaluate>>>>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`timed out after ${WORKFLOW_MOVE_POLICY_TIMEOUT_MS}ms`));
          }, WORKFLOW_MOVE_POLICY_TIMEOUT_MS);
          Promise.resolve(extension.evaluate?.(input))
            .then((value) => {
              clearTimeout(timer);
              resolve(value as Awaited<ReturnType<NonNullable<typeof extension.evaluate>>>);
            })
            .catch((error) => {
              clearTimeout(timer);
              reject(error);
            });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        storeLog.warn("Workflow move-policy extension faulted", {
          phase: "moveTaskInternal:move-policy",
          taskId: input.task.id,
          extensionId: definition.id,
          fallback: extension.fallback,
          error: message,
        });
        if (extension.fallback === "degradeToDefault") {
          getWorkflowExtensionRegistry().degrade([definition.id], "runtime-fault", message);
          continue;
        }
        throw new TransitionRejectionError(
          makeTransitionRejection(
            "guard-rejected",
            "transition.rejected.workflowMovePolicy",
            extension.fallback === "parkNeedsAttention",
            `Move policy '${definition.id}' failed: ${message}`,
          ),
          `Cannot move ${input.task.id} to '${input.toColumn}': move policy '${definition.id}' failed`,
        );
      }

      if (!decision.allowed) {
        throw new TransitionRejectionError(
          makeTransitionRejection(
            "guard-rejected",
            "transition.rejected.workflowMovePolicy",
            true,
            decision.reason,
          ),
          decision.message,
        );
      }
    }
  }

export async function recordRunAuditEventImpl(store: TaskStore, input: RunAuditEventInput): Promise<RunAuditEvent> {
    // FNXC:RuntimeWorkflowAsync 2026-06-24-16:11:
    // Backend-mode: delegate to the async data-layer helper. The data-layer
    // RunAuditEvent has taskId: string | null (DB shape); the store's public
    // RunAuditEvent type has taskId: string | undefined. Map null → undefined.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const raw = await recordRunAuditEventAsync(layer, {
        timestamp: input.timestamp,
        taskId: input.taskId,
        agentId: input.agentId,
        runId: input.runId,
        domain: input.domain,
        mutationType: input.mutationType,
        target: input.target,
        metadata: input.metadata,
      });
      return {
        ...raw,
        taskId: raw.taskId ?? undefined,
        domain: raw.domain as RunAuditEvent["domain"],
        metadata: raw.metadata ?? undefined,
      };
    }
    const id = randomUUID();
    const timestamp = input.timestamp ?? new Date().toISOString();

    const event: RunAuditEvent = {
      id,
      timestamp,
      taskId: input.taskId,
      agentId: input.agentId,
      runId: input.runId,
      domain: input.domain,
      mutationType: input.mutationType,
      target: input.target,
      metadata: input.metadata,
    };

    store.db.transactionImmediate(() => {
      store.db.prepare(`
        INSERT INTO runAuditEvents (
          id, timestamp, taskId, agentId, runId, domain, mutationType, target, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.timestamp,
        event.taskId ?? null,
        event.agentId,
        event.runId,
        event.domain,
        event.mutationType,
        event.target,
        toJsonNullable(event.metadata),
      );
    });

    return event;
  }

export function getRunAuditEventsImpl(store: TaskStore, options: RunAuditEventFilter = {}): RunAuditEvent[] {
    /*
    FNXC:PostgresCutover 2026-07-04-00:00:
    Intentional PG safe-default: this sync reader returns [] in backend mode. The production
    callers (executor.ts:5482, self-healing.ts:908/1078) use typeof guards + handle empty
    gracefully (no crash, graceful degrade to "no audit events found"). The authoritative
    async read is queryRunAuditEvents (async-audit.ts). This sync API stays as the test/mock
    fallback — 37+ test files call it directly. Not a follow-up; this is the correct PG behavior.
    */
    if (store.backendMode) return [];
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.runId) {
      conditions.push("runId = ?");
      params.push(options.runId);
    }

    if (options.taskId) {
      conditions.push("taskId = ?");
      params.push(options.taskId);
    }

    if (options.agentId) {
      conditions.push("agentId = ?");
      params.push(options.agentId);
    }

    if (options.domain) {
      conditions.push("domain = ?");
      params.push(options.domain);
    }

    if (options.mutationType) {
      conditions.push("mutationType = ?");
      params.push(options.mutationType);
    }

    // Inclusive time range: timestamp >= startTime AND timestamp <= endTime
    if (options.startTime) {
      conditions.push("timestamp >= ?");
      params.push(options.startTime);
    }

    if (options.endTime) {
      conditions.push("timestamp <= ?");
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = options.limit ? `LIMIT ${Math.max(1, options.limit)}` : "";
    const orderClause = "ORDER BY timestamp DESC, rowid DESC";

    // Cast params to the expected SQLite input type
    const sqlParams = params as (string | number | null)[];

    const rows = store.db.prepare(`
      SELECT * FROM runAuditEvents
      ${whereClause}
      ${orderClause}
      ${limitClause}
    `).all(...sqlParams) as unknown as RunAuditEventRow[];

    return rows.map((row) => store.rowToRunAuditEvent(row));
  }

export function getWorkflowParitySummaryImpl(store: TaskStore, options: { since?: string; limit?: number } = {}): WorkflowParitySummary {
    const limit = options.limit ?? 1000;
    const observed = store.getRunAuditEvents({
      domain: "database",
      mutationType: WORKFLOW_PARITY_OBSERVED_MUTATION as unknown as RunAuditEvent["mutationType"],
      startTime: options.since,
      limit,
    });
    const driftEvents = store.getRunAuditEvents({
      domain: "database",
      mutationType: WORKFLOW_PARITY_DRIFT_MUTATION as unknown as RunAuditEvent["mutationType"],
      startTime: options.since,
      limit,
    });

    let agreed = 0;
    for (const event of observed) {
      if (event.metadata?.agree === true) agreed += 1;
    }

    const driftFieldCounts: Record<string, number> = {};
    const recentDrift: WorkflowParitySummary["recentDrift"] = [];
    for (const event of driftEvents) {
      const diffs = Array.isArray(event.metadata?.diffs)
        ? (event.metadata.diffs as WorkflowParityDiff[])
        : [];
      for (const diff of diffs) {
        driftFieldCounts[diff.field] = (driftFieldCounts[diff.field] ?? 0) + 1;
      }
      if (recentDrift.length < 20) {
        recentDrift.push({ taskId: event.taskId ?? event.target, timestamp: event.timestamp, diffs });
      }
    }

    return {
      observed: observed.length,
      agreed,
      drift: driftEvents.length,
      agreeRate: observed.length > 0 ? agreed / observed.length : 0,
      driftFieldCounts,
      recentDrift,
    };
  }

export function dequeueMergeQueueOnColumnExitImpl(store: TaskStore, taskId: string, previousColumn: ColumnId, nextColumn: ColumnId, now: string): void {
    if (previousColumn !== "in-review" || nextColumn === "in-review") {
      return;
    }

    const queueRow = store.db.prepare("SELECT leasedBy, leaseExpiresAt FROM mergeQueue WHERE taskId = ?").get(taskId) as {
      leasedBy: string | null;
      leaseExpiresAt: string | null;
    } | undefined;
    if (!queueRow) {
      return;
    }

    const leaseIsExpired = queueRow.leaseExpiresAt != null && queueRow.leaseExpiresAt <= now;
    if (!queueRow.leasedBy || leaseIsExpired) {
      store.db.prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(taskId);
      store.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "mergeQueue:auto-cleanup-stale-row",
        target: taskId,
        metadata: {
          taskId,
          previousColumn,
          nextColumn,
          leasedBy: queueRow.leasedBy,
          leaseExpiresAt: queueRow.leaseExpiresAt,
          cleanedAt: now,
          reason: "column-exit",
        },
      });
      return;
    }

    store.insertRunAuditEventRow({
      taskId,
      domain: "database",
      mutationType: "mergeQueue:stale-lease-on-column-exit",
      target: taskId,
      metadata: {
        taskId,
        previousColumn,
        nextColumn,
        leasedBy: queueRow.leasedBy,
        leaseExpiresAt: queueRow.leaseExpiresAt,
      },
    });
  }

export async function updateIssueInfoImpl(store: TaskStore, id: string, issueInfo: import("../types.js").IssueInfo | null,): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);

      const previous = task.issueInfo;
      const badgeChanged =
        previous?.url !== issueInfo?.url ||
        previous?.number !== issueInfo?.number ||
        previous?.state !== issueInfo?.state ||
        previous?.title !== issueInfo?.title ||
        previous?.stateReason !== issueInfo?.stateReason;
      const linkChanged = previous?.number !== issueInfo?.number || previous?.url !== issueInfo?.url;

      if (issueInfo) {
        task.issueInfo = issueInfo;
        if (!previous || linkChanged) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Issue linked",
            outcome: `Issue #${issueInfo.number}: ${issueInfo.url}`,
          });
        } else if (badgeChanged) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Issue updated",
            outcome: `Issue #${issueInfo.number} badge metadata refreshed`,
          });
        }
      } else {
        task.issueInfo = undefined;
        if (previous?.number) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Issue unlinked",
            outcome: `Issue #${previous.number} removed`,
          });
        }
      }

      task.updatedAt = new Date().toISOString();

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });

      if (badgeChanged) {
        store.emit("task:updated", task);
      }

      return task;
    });
  }

export async function listWorkflowStepsImpl(store: TaskStore): Promise<import("../types.js").WorkflowStep[]> {
    if (store.workflowStepsCache) return store.workflowStepsCache;
    /*
     * FNXC:SqliteFinalRemoval 2026-06-24-15:40:
     * In backend mode (PostgreSQL), the workflow_steps table read path has not
     * been converted to the async Drizzle helper yet. Return only the plugin-
     * contributed steps (which are in-memory, not DB-backed) so task creation
     * does not throw when auto-defaulting workflow steps. The stored steps are
     * empty until the async workflow-step helper is implemented. This matches
     * the existing fail-soft behavior (the catch block logged a warning and
     * continued with no default steps).
     */
    if (store.backendMode) {
      const pluginSteps = store._pluginWorkflowStepTemplates
        .map(({ template }) => store.resolvePluginWorkflowStep(template.id))
        .filter((step): step is import("../types.js").WorkflowStep => Boolean(step));
      store.workflowStepsCache = pluginSteps;
      return store.workflowStepsCache;
    }
    const rows = store.db.prepare("SELECT * FROM workflow_steps ORDER BY createdAt ASC").all() as Array<{
      id: string;
      templateId: string | null;
      name: string;
      description: string;
      mode: string;
      phase: string | null;
      prompt: string;
      gateMode: string | null;
      toolMode: string | null;
      scriptName: string | null;
      enabled: number;
      defaultOn: number | null;
      modelProvider: string | null;
      modelId: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    const storedSteps = rows
      .map((row) => store.applyLegacyWorkflowStepOverrides(store.toStoredWorkflowStep(row)))
      // Steps materialized by compiling a workflow are an execution detail; keep
      // them out of the user-facing step manager listing. The executor resolves
      // them directly via getWorkflowStep, which is unaffected by this filter.
      .filter((step) => !step.templateId?.startsWith(WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX));
    const pluginSteps = store._pluginWorkflowStepTemplates
      .map(({ template }) => store.resolvePluginWorkflowStep(template.id))
      .filter((step): step is import("../types.js").WorkflowStep => Boolean(step));
    store.workflowStepsCache = [...storedSteps, ...pluginSteps];
    return store.workflowStepsCache;
  }

export async function getWorkflowStepImpl(store: TaskStore, id: string): Promise<import("../types.js").WorkflowStep | undefined> {
    if (id.startsWith("plugin:")) {
      const pluginStep = store.resolvePluginWorkflowStep(id);
      if (pluginStep) {
        return pluginStep;
      }
    }

    const byId = store.db.prepare("SELECT * FROM workflow_steps WHERE id = ?").get(id) as
      | {
          id: string;
          templateId: string | null;
          name: string;
          description: string;
          mode: string;
          phase: string | null;
          gateMode: string | null;
          prompt: string;
          toolMode: string | null;
          scriptName: string | null;
          enabled: number;
          defaultOn: number | null;
          modelProvider: string | null;
          modelId: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    if (byId) {
      return store.applyLegacyWorkflowStepOverrides(store.toStoredWorkflowStep(byId));
    }

    const byTemplate = store.db
      .prepare("SELECT * FROM workflow_steps WHERE templateId = ? ORDER BY createdAt ASC LIMIT 1")
      .get(id) as
      | {
          id: string;
          templateId: string | null;
          name: string;
          description: string;
          mode: string;
          phase: string | null;
          gateMode: string | null;
          prompt: string;
          toolMode: string | null;
          scriptName: string | null;
          enabled: number;
          defaultOn: number | null;
          modelProvider: string | null;
          modelId: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    if (byTemplate) {
      return store.applyLegacyWorkflowStepOverrides(store.toStoredWorkflowStep(byTemplate));
    }

    const template = store.getBuiltInWorkflowTemplate(id);
    return template ? store.toBuiltInWorkflowStep(template) : undefined;
  }

export async function createWorkflowDefinitionImpl(store: TaskStore, input: WorkflowDefinitionInput,): Promise<WorkflowDefinition> {
    // Rollback compat (#1405): with the flag OFF, persist a pure-v1-equivalent
    // graph in the v1 shape so a binary downgrade can still load the row.
    const flagOnForCreate = await store.workflowColumnsFlagOn();
    return store.withConfigLock(async () => {
      const name = input.name?.trim();
      if (!name) throw new Error("Workflow name is required");
      // Validate the IR shape up front so we never persist a malformed graph.
      const ir = parseWorkflowIr(input.ir);
      // Residual A: also reject save-blocking trait composition conflicts here,
      // not only in the editor's client-side validation.
      store.assertWorkflowIrTraitsValid(ir);
      const layout = input.layout ?? {};
      const now = new Date().toISOString();
      // FNXC:SqliteFinalRemoval 2026-06-28:
      // Backend mode (PG) allocates the WF-id from project.config via the async
      // counter; the sync store.nextWorkflowDefinitionId() reads a SQLite __meta
      // row that does not exist in PG. The id is computed up front so the
      // definition object is identical across both branches.
      const id = store.backendMode
        ? await nextWorkflowDefinitionIdAsyncImpl(store)
        : store.nextWorkflowDefinitionId();
      const definition: WorkflowDefinition = {
        id,
        name,
        description: input.description ?? "",
        // KTD-1: fragments are pure-v1 IRs and pass through downgradeIrToV1IfPure
        // unchanged; default to "workflow" when the caller omits the kind.
        kind: input.kind === "fragment" ? "fragment" : "workflow",
        ir,
        layout,
        createdAt: now,
        updatedAt: now,
      };

      if (store.backendMode) {
        // FNXC:SqliteFinalRemoval 2026-06-28:
        // PG INSERT via Drizzle. ir/layout are jsonb columns, so the OBJECT is
        // passed directly (no serializeWorkflowIr/JSON.stringify — that is the
        // SQLite TEXT path). Mirrors updateWorkflowDefinitionImpl's backend
        // branch; bumpLastModified is skipped in backend mode.
        await store.asyncLayer!.db.insert(schema.project.workflows).values({
          id: definition.id,
          name: definition.name,
          description: definition.description,
          ir: (flagOnForCreate ? definition.ir : downgradeIrToV1IfPure(definition.ir)) as unknown as object,
          layout: definition.layout as unknown as object,
          kind: definition.kind,
          createdAt: definition.createdAt,
          updatedAt: definition.updatedAt,
        });
        store.workflowDefinitionsCache = null;
        return definition;
      }

      store.db
        .prepare(
          `INSERT INTO workflows (id, name, description, ir, layout, kind, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          definition.id,
          definition.name,
          definition.description,
          serializeWorkflowIr(
            flagOnForCreate ? definition.ir : downgradeIrToV1IfPure(definition.ir),
          ),
          JSON.stringify(definition.layout),
          definition.kind,
          definition.createdAt,
          definition.updatedAt,
        );

      store.workflowDefinitionsCache = null;
      store.db.bumpLastModified();
      return definition;
    });
  }

export function countActiveInCapacitySlotSyncImpl(store: TaskStore, params: { targetColumn: string; workflowId: string; countPending: boolean; excludeTaskId: string; }): number {
    const { targetColumn, workflowId, countPending, excludeTaskId } = params;
    // Candidate rows: in the column now, or (optionally) mid-transition into it.
    // LEFT JOIN the selection row so we can scope by effective workflow id in JS.
    const rows = store.db
      .prepare(
        `SELECT t.id AS id, t."column" AS col, t.transitionPending AS tp, s.workflowId AS wid
         FROM tasks t
         LEFT JOIN task_workflow_selection s ON s.taskId = t.id
         WHERE t.deletedAt IS NULL
           AND t.id != ?
           AND (t."column" = ? OR (t.transitionPending IS NOT NULL AND t.transitionPending != ''))`,
      )
      .all(excludeTaskId, targetColumn) as Array<{
        id: string;
        col: string;
        tp: string | null;
        wid: string | null;
      }>;

    let count = 0;
    for (const row of rows) {
      const effectiveWorkflowId = row.wid ?? TaskStore.DEFAULT_WORKFLOW_POOL_ID;
      if (effectiveWorkflowId !== workflowId) continue;

      if (row.col === targetColumn) {
        count += 1;
        continue;
      }
      // Not committed into the column — only counts if it has reserved the slot
      // via a transitionPending marker targeting this column AND countPending.
      if (!countPending || !row.tp) continue;
      let toColumn: string | undefined;
      try {
        const parsed = JSON.parse(row.tp) as { toColumn?: unknown };
        if (typeof parsed.toColumn === "string") toColumn = parsed.toColumn;
      } catch {
        // Corrupt marker — treat as not holding this slot.
      }
      if (toColumn === targetColumn) count += 1;
    }
    return count;
  }

export async function countActiveInCapacitySlotAsyncImpl(store: TaskStore, params: { tx: DbTransaction; targetColumn: string; workflowId: string; countPending: boolean; excludeTaskId: string; }): Promise<number> {
    const { tx, targetColumn, workflowId, countPending, excludeTaskId } = params;
    const rows = await tx
      .select({
        id: schema.project.tasks.id,
        col: schema.project.tasks.column,
        tp: schema.project.tasks.transitionPending,
        wid: schema.project.taskWorkflowSelection.workflowId,
      })
      .from(schema.project.tasks)
      .leftJoin(
        schema.project.taskWorkflowSelection,
        eq(schema.project.taskWorkflowSelection.taskId, schema.project.tasks.id),
      )
      .where(
        and(
          isNull(schema.project.tasks.deletedAt),
          ne(schema.project.tasks.id, excludeTaskId),
          or(
            eq(schema.project.tasks.column, targetColumn),
            and(
              sql`${schema.project.tasks.transitionPending} IS NOT NULL`,
              sql`${schema.project.tasks.transitionPending} != ''`,
            ),
          ),
        ),
      );

    let count = 0;
    for (const row of rows) {
      const effectiveWorkflowId = row.wid ?? TaskStore.DEFAULT_WORKFLOW_POOL_ID;
      if (effectiveWorkflowId !== workflowId) continue;

      if (row.col === targetColumn) {
        count += 1;
        continue;
      }
      if (!countPending || !row.tp) continue;
      let toCol: string | undefined;
      try {
        const parsed = JSON.parse(row.tp) as { toColumn?: unknown };
        if (typeof parsed.toColumn === "string") toCol = parsed.toColumn;
      } catch {
        // Corrupt marker — treat as not holding this slot.
      }
      if (toCol === targetColumn) count += 1;
    }
    return count;
  }

export function generateSpecifiedPromptImpl(store: TaskStore, task: Task): string {
    const deps =
      task.dependencies.length > 0
        ? task.dependencies.map((d) => `- **Task:** ${d}`).join("\n")
        : "- **None**";

    // Get current settings to check for ntfy configuration
    const settings = store.getSettingsSync();
    const notificationsSection =
      settings.ntfyEnabled && settings.ntfyTopic
        ? `\n## Notifications\n\nntfy topic: \`${settings.ntfyTopic}\`\n`
        : "";

    const heading = task.title ? `${task.id}: ${task.title}` : task.id;
    return `# ${heading}

**Created:** ${task.createdAt.split("T")[0]}
**Size:** M

## Mission

${task.description}

## Dependencies

${deps}

## Steps

### Step 1: Implementation

- [ ] Implement the required changes
- [ ] Verify changes work correctly

### Step 2: Testing & Verification

- [ ] Lint passes
- [ ] All tests pass
- [ ] Typecheck passes
- [ ] No regressions introduced

### Step 3: Documentation & Delivery

- [ ] Update relevant documentation

## Acceptance Criteria

- [ ] All steps complete
- [ ] All tests passing
${notificationsSection}`;
  }

export async function recordActivityImpl(store: TaskStore, entry: Omit<ActivityLogEntry, "id" | "timestamp">): Promise<ActivityLogEntry> {
    // FNXC:RuntimeWorkflowAsync 2026-06-24-16:01:
    // Backend-mode: delegate to the async audit helper (async-audit.ts).
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return recordActivityLogEntryAsync(layer.db, entry);
    }
    const fullEntry: ActivityLogEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    };

    try {
      store.db.prepare(
        `INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        fullEntry.id,
        fullEntry.timestamp,
        fullEntry.type,
        fullEntry.taskId ?? null,
        fullEntry.taskTitle ?? null,
        fullEntry.details,
        fullEntry.metadata ? JSON.stringify(fullEntry.metadata) : null,
      );
      store.db.bumpLastModified();
    } catch (err) {
      // Best-effort: log errors but don't break operations
      storeLog.error("Failed to record activity", {
        id: fullEntry.id,
        type: fullEntry.type,
        taskId: fullEntry.taskId,
        taskTitle: fullEntry.taskTitle,
        detailsLength: fullEntry.details.length,
        hasMetadata: fullEntry.metadata !== undefined,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return fullEntry;
  }

export function getEvalStoreImpl(store: TaskStore): EvalStore | AsyncEvalStore {
    if (!store.evalStore) {
      // FNXC:EvalStore 2026-06-27-12:30:
      // PG backend mode returns the AsyncDataLayer-backed AsyncEvalStore. The
      // sync EvalStore(store.db) dereferences the absent SQLite handle, which
      // 500'd the dashboard /api/evals routes.
      if (store.backendMode) {
        const layer = store.getAsyncLayer();
        if (!layer) {
          throw new Error("EvalStore is not available: AsyncDataLayer not initialized in backend mode");
        }
        store.evalStore = new AsyncEvalStore(layer);
      } else {
        store.evalStore = new EvalStore(store.db);
      }
    }
    return store.evalStore;
  }

