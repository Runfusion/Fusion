/**
 * Task move/lifecycle transition operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {type TaskStore, type MoveTaskOptions, type MoveTaskInternalOptions, storeLog, isWorkflowColumnsCompatibilityFlagEnabled} from "../store.js";
import * as schema from "../postgres/schema/index.js";
import {TaskDeletedError, HandoffInvariantViolationError, TransitionRejectionError} from "./errors.js";
import {eq, sql} from "drizzle-orm";
import type {Task, Column, ColumnId, HandoffToReviewOptions} from "../types.js";
import {VALID_TRANSITIONS, COLUMNS} from "../types.js";
import {serializeWorkflowIr} from "../workflow-ir.js";
import {resolveAllowedColumns, workflowHasColumn} from "../workflow-transitions.js";
import {isBuiltinWorkflowId, getBuiltinWorkflow, resolveDefaultWorkflowIr, DEFAULT_WORKFLOW_ID} from "../builtin-workflows.js";
import {parseWorkflowIr} from "../workflow-ir.js";
import {findWorkflowColumn, resolveColumnPluginGates} from "../plugin-gate-verdict.js";
import {getTraitRegistry, resolveColumnFlags} from "../trait-registry.js";
import {resolveColumnCapacity, resolveWipBudgetColumns} from "../workflow-capacity.js";
import {
  type TransitionColumnFacts,
  evaluateCapacityRejection,
  evaluateTransitionInvariants,
} from "../workflow-transition-policy.js";
import {type DefaultWorkflowMoveContext, applyDefaultWorkflowMoveEffects} from "../default-workflow-hooks.js";
import {makeTransitionRejection, makeTransitionPending} from "../transition-types.js";
import {writeTransitionPending, clearTransitionPending} from "../transition-pending.js";
import {writeTransitionPendingAsync, clearTransitionPendingAsync} from "./async-transition-pending.js";
import type {WorkflowIr} from "../workflow-ir-types.js";
import "../builtin-traits.js";
import {recordRunAuditEventWithinTransaction} from "../postgres/data-layer.js";
import {getTaskMergeBlocker} from "../task-merge.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {readTaskRow as readTaskRowAsync, readTaskRowInTransaction, upsertTaskRowInTransaction} from "../task-store/async-persistence.js";
import {disposeTaskBeforeMove} from "../task-move-disposer.js";

/*
FNXC:PostgresCutover 2026-07-05-19:50:
Backend-aware task-workflow IR resolution for move validation. The sync
resolver (resolveTaskWorkflowIrSync) cannot read the task_workflow_selection
row in backend mode (PostgreSQL is async-only) and silently falls back to
builtin:coding — which rejected every move out of a custom workflow column
(e.g. Coding (Ideas) "ideas"). Moves are async, so resolve the selection via
getTaskWorkflowSelectionAsync and map it to the same IR the sync path would.
*/
async function resolveTaskWorkflowIrForMove(store: TaskStore, id: string): Promise<WorkflowIr> {
  if (!store.backendMode) {
    return store.resolveTaskWorkflowIrSync(id);
  }
  const selection = await store.getTaskWorkflowSelectionAsync(id);
  const workflowId = selection?.workflowId;
  /* FNXC:WorkflowBuiltins 2026-07-19-10:24: every no-selection/unresolvable fallback goes through resolveDefaultWorkflowIr() so this resolver and prepareWorkflowMovePolicyPreflightImpl agree on the default IR (see the helper's note on the "preflight is stale" drift). */
  if (!workflowId) return store.applyBuiltInPromptOverridesSync(DEFAULT_WORKFLOW_ID, resolveDefaultWorkflowIr());
  if (isBuiltinWorkflowId(workflowId)) {
    const builtin = getBuiltinWorkflow(workflowId);
    const ir = builtin?.ir;
    return store.applyBuiltInPromptOverridesSync(workflowId, ir === undefined ? resolveDefaultWorkflowIr() : typeof ir === "string" ? parseWorkflowIr(ir) : ir);
  }
  try {
    const def = await store.getWorkflowDefinition(workflowId);
    return def ? parseWorkflowIr(def.ir) : resolveDefaultWorkflowIr();
  } catch {
    return resolveDefaultWorkflowIr();
  }
}
import {enqueueMergeQueueInTransaction, dequeueMergeQueueOnColumnExitInTransaction} from "../task-store/async-merge-coordination.js";

/*
FNXC:WorkflowTransitionPolicy 2026-07-18-19:52:
Resolve a column's trait-derived facts (id + OR-merged flags) for the shared
transition validator (KTD-5). An unknown/legacy column absent from the workflow
IR resolves to empty flags — the legacy VALID_TRANSITIONS adjacency already
gates those moves, so the invariant policy simply does not fire on them.
*/
function resolveTransitionColumnFacts(ir: WorkflowIr, columnId: string): TransitionColumnFacts {
  const column = findWorkflowColumn(ir, columnId);
  return {
    columnId,
    flags: column ? resolveColumnFlags(column) : {},
  };
}

/*
FNXC:WorkflowCapacity 2026-07-19-10:35:
Shared pooled-capacity enforcement (U4/KTD-9/KTD-10), extracted from the async
(backend transaction) and sync (SQLite transaction) move paths, which had the
identical resolve-budget → count-occupants → verdict → throw sequence inline.
Parameterized by a count callback so each path supplies its own in-transaction
counter. The occupant fold is maybe-async on purpose: the sync SQLite path runs
inside a synchronous `db.transactionImmediate` callback and MUST count, judge,
and throw synchronously (a returned promise there would escape the
transaction), while the backend path awaits the returned promise. Counting
stays sequential in the async case, matching the original per-column awaits
against the same transaction handle. A shared `limitSetting` pools multiple
wip columns, so occupants are summed across every column sharing the target's
budget — a task occupies exactly one column, so the sum never double-counts.
KTD-5: the ONE capacity counter feeds the ONE capacity-verdict authority
(`evaluateCapacityRejection`).
*/
function enforcePooledColumnCapacity(args: {
  workflowIr: WorkflowIr;
  toColumn: string;
  taskId: string;
  capacity: { limit: number; countPending: boolean };
  countOccupants: (budgetColumn: string, countPending: boolean) => number | Promise<number>;
}): void | Promise<void> {
  const { workflowIr, toColumn, taskId, capacity, countOccupants } = args;
  const budgetColumns = resolveWipBudgetColumns(workflowIr, toColumn);
  const judge = (occupants: number): void => {
    const capacityRejection = evaluateCapacityRejection(toColumn, {
      limit: capacity.limit,
      occupants,
    });
    if (capacityRejection) {
      throw new TransitionRejectionError(
        capacityRejection,
        `Cannot move ${taskId} to '${toColumn}': column at capacity (${occupants}/${capacity.limit})`,
      );
    }
  };
  const step = (index: number, occupants: number): void | Promise<void> => {
    if (index >= budgetColumns.length) return judge(occupants);
    const count = countOccupants(budgetColumns[index], capacity.countPending);
    if (typeof count === "number") return step(index + 1, occupants + count);
    return count.then((resolved) => step(index + 1, occupants + resolved));
  };
  return step(0, 0);
}

export async function moveTaskImpl(store: TaskStore, id: string, toColumn: ColumnId, options?: MoveTaskOptions,): Promise<Task> {
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:15:
    // Backend-mode moveTask: the moveTaskInternal orchestration now handles
    // backend mode by using layer.transactionImmediate(async (tx) => ...) instead
    // of sync db.transactionImmediate, and async in-transaction helpers for
    // merge-queue enqueue/dequeue and audit. The transition guards, side effects,
    // and workflow hooks are pure JS and run unchanged. The SQLite path below
    // is byte-identical to before.
    // ColumnId admits workflow-defined custom column ids (KTD-1). Both paths
    // runtime-validate: flag-ON against the task's resolved workflow, flag-OFF
    // via the VALID_TRANSITIONS lookup (non-legacy ids reject as before).
    const movePolicyPreflight = await store.prepareWorkflowMovePolicyPreflight(id, toColumn, options, { fromHandoff: false });
    return store.withTaskLock(id, () => store.moveTaskInternal(id, toColumn, options, { fromHandoff: false, movePolicyPreflight }));
  }

export async function handoffToReviewImpl(store: TaskStore, taskId: string, opts: HandoffToReviewOptions): Promise<Task> {
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:20:
    // Backend-mode handoffToReview: delegates to moveTaskInternal which now
    // handles backend mode. The handoff transactional invariant (column move +
    // mergeQueue insert + audit in one transaction) is preserved by
    // enqueueMergeQueueInTransaction and recordRunAuditEventWithinTransaction
    // running inside layer.transactionImmediate.
    return store.withTaskLock(taskId, async () => {
      let task: Task;
      try {
        task = await store.readTaskForMove(taskId);
      } catch (error) {
        if (error instanceof TaskDeletedError) {
          // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:45:
          // Backend mode: read the deleted task via async getTask (includeDeleted
          // path). SQLite path: sync readTaskFromDb.
          let deletedTaskColumn: string = "todo";
          if (store.backendMode) {
            const layer = store.asyncLayer!;
            const pgRow = await readTaskRowAsync(layer, taskId, { includeDeleted: true });
            if (pgRow) {
              deletedTaskColumn = (pgRow.column as string) ?? "todo";
            }
          } else {
            const deletedTask = store.readTaskFromDb(taskId, { includeDeleted: true });
            deletedTaskColumn = deletedTask?.column ?? "todo";
          }
          throw new HandoffInvariantViolationError(
            taskId,
            deletedTaskColumn,
            `Cannot hand off ${taskId} to in-review because the task is deleted`,
          );
        }
        throw error;
      }

      if (task.column === "archived" || task.deletedAt != null) {
        throw new HandoffInvariantViolationError(
          taskId,
          task.column,
          `Cannot hand off ${taskId} to in-review from ${task.column}`,
        );
      }

      return store.moveTaskInternal(
        taskId,
        "in-review",
        {
          ...opts.moveOptions,
          skipMergeBlocker: true,
          // KTD-9: handoff is an engine/recovery-class move; its skipMergeBlocker
          // maps onto bypassGuards under the flag (identical behavior both paths).
          bypassGuards: true,
        },
        {
          fromHandoff: true,
          runContext: {
            runId: opts.evidence.runId,
            agentId: opts.evidence.agentId,
          },
          ownerAgentId: opts.ownerAgentId,
          evidence: opts.evidence,
          now: opts.now,
        },
        task,
      );
    });
  }

export async function moveTaskInternalImpl(store: TaskStore, id: string, toColumn: ColumnId, options: MoveTaskOptions | undefined, internal: MoveTaskInternalOptions, currentTask?: Task,): Promise<Task> {
    const dir = store.taskDir(id);
    const task = currentTask ?? await store.readTaskForMove(id);
    /*
    FNXC:TaskMovement 2026-06-22-18:20:
    Public moveTask calls without an explicit source keep the legacy emitted source of "engine", but they do not inherit workflow guard bypass. Engine, scheduler, handoff, and recovery call sites opt into bypass semantics with an explicit moveSource or skipMergeBlocker.
    */
    const moveSource = options?.moveSource ?? "engine";

    // ── U4: flag-gated workflow-resolved transition path (KTD-8) ─────────────
    // Flag OFF (default): the legacy `VALID_TRANSITIONS` / inline-side-effect
    // path below runs byte-identical (proven by the characterization suite).
    // FNXC:WorkflowColumns 2026-06-22-18:22:
    // The flag-OFF path is still an active compatibility contract for changed-test recovery: it must throw bare Error for invalid legacy moves, persist v1 workflow IR, and support ON→OFF evacuation. Do not route flag-OFF callers through typed workflow-column rejections until the legacy path is intentionally removed.
    // Flag ON: validate against the task's resolved workflow column graph, run
    // sync trait guards (unless bypassed), and route the legacy per-column side
    // effects through the default-workflow trait hooks.
    // `experimentalFeatures` is a global-scoped setting, so the project-only
    // `getSettingsSync()` row would miss it — read merged settings (global +
    // project) via getSettingsFast(). This is an async read taken before the
    // lock-sensitive transaction; it does not touch the task lock.
    const mergedSettingsForMove = await store.getSettingsFast();
    const useWorkflow = isWorkflowColumnsCompatibilityFlagEnabled(mergedSettingsForMove);
    // bypassGuards (KTD-9): engine-sourced moves + the existing skipMergeBlocker
    // call sites map onto it. Capacity (KTD-10) is NEVER bypassed by this — the
    // capacity check is not a guard (U6 fills the enforcement; U4 leaves a
    // pass-through slot). An explicit option value wins; otherwise derive it.
    const bypassGuards = store.resolveWorkflowBypassGuards(moveSource, options);
    const effectiveWorkflowIdForMove = useWorkflow
      ? (await store.getTaskWorkflowSelectionAsync(id))?.workflowId ?? "builtin:coding"
      : "builtin:coding";
    const workflowIr: WorkflowIr | undefined = useWorkflow
      ? await resolveTaskWorkflowIrForMove(store, id)
      : undefined;

    if (task.column === toColumn) {
      if (internal.fromHandoff && toColumn === "in-review") {
        // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:25:
        // Backend-mode same-column handoff: use layer.transactionImmediate with
        // async in-transaction helpers (enqueueMergeQueueInTransaction,
        // recordRunAuditEventWithinTransaction) instead of sync SQLite.
        if (store.backendMode) {
          const layer = store.asyncLayer!;
          await layer.transactionImmediate(async (tx) => {
            const liveRow = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, layer.projectId);
            if (liveRow?.deletedAt) {
              throw new HandoffInvariantViolationError(
                id,
                task.column,
                `Cannot hand off ${id} to in-review because the task is deleted`,
              );
            }
            const existingRows = await tx
              .select({ one: sql`1` })
              .from(schema.project.mergeQueue)
              .where(eq(schema.project.mergeQueue.taskId, id))
              .limit(1);
            const existing = existingRows.length > 0;
            await recordRunAuditEventWithinTransaction(tx, {
              taskId: id,
              agentId: internal.runContext?.agentId ?? "system",
              runId: internal.runContext?.runId ?? "unknown",
              domain: "database",
              mutationType: "task:move",
              target: id,
              metadata: {
                from: task.column,
                to: toColumn,
                moveSource,
              },
            });
            await enqueueMergeQueueInTransaction(tx, id, { priority: task.priority, now: internal.now }, {
              agentId: internal.runContext?.agentId,
              runId: internal.runContext?.runId,
            });
            // FNXC:PostgresCutover 2026-07-15-12:00:
            // Same-column retries must share the outer handoff transaction too,
            // so workflow work cannot survive a rolled-back queue/audit handoff.
            await store.createCompletionHandoffWorkflowWork(task, {
              runId: internal.runContext?.runId,
              now: internal.now,
              source: internal.evidence?.reason,
            }, tx);
            await recordRunAuditEventWithinTransaction(tx, {
              taskId: id,
              agentId: internal.runContext?.agentId ?? "system",
              runId: internal.runContext?.runId ?? "unknown",
              domain: "database",
              mutationType: "task:handoff",
              target: id,
              metadata: {
                taskId: id,
                fromColumn: task.column,
                ownerAgentId: internal.ownerAgentId ?? null,
                reason: internal.evidence?.reason,
                runId: internal.runContext?.runId,
                agentId: internal.runContext?.agentId,
                alreadyEnqueued: existing,
              },
            });
            /*
            FNXC:HandoffFailureInjection 2026-07-15-12:00:
            Backend handoffs bypass the legacy enqueueMergeQueueSyncInternal spy.
            This test-only no-op seam runs after every VAL-DATA-013 sub-write
            (move, queue, workflow work, and handoff audit), so an injected throw
            proves this transaction rolls all of them back.
            */
            await store.__invokeHandoffMergeQueueFailureInjectorForTesting(id);
          });
          return task;
        }
        store.db.transactionImmediate(() => {
          const liveRow = store.readTaskFromDb(id, { includeDeleted: true });
          if (liveRow?.deletedAt) {
            throw new HandoffInvariantViolationError(
              id,
              task.column,
              `Cannot hand off ${id} to in-review because the task is deleted`,
            );
          }
          const existing = store.db.prepare("SELECT 1 FROM mergeQueue WHERE taskId = ?").get(id) as { 1: number } | undefined;
          store.insertRunAuditEventRow({
            taskId: id,
            agentId: internal.runContext?.agentId,
            runId: internal.runContext?.runId,
            domain: "database",
            mutationType: "task:move",
            target: id,
            metadata: {
              from: task.column,
              to: toColumn,
              moveSource,
            },
          });
          store.enqueueMergeQueueSyncInternal(id, { priority: task.priority, now: internal.now });
          store.createCompletionHandoffWorkflowWork(task, {
            runId: internal.runContext?.runId,
            now: internal.now,
            source: internal.evidence?.reason,
          });
          store.insertRunAuditEventRow({
            taskId: id,
            agentId: internal.runContext?.agentId,
            runId: internal.runContext?.runId,
            domain: "database",
            mutationType: "task:handoff",
            target: id,
            metadata: {
              taskId: id,
              fromColumn: task.column,
              ownerAgentId: internal.ownerAgentId ?? null,
              reason: internal.evidence?.reason,
              runId: internal.runContext?.runId,
              agentId: internal.runContext?.agentId,
              alreadyEnqueued: Boolean(existing),
            },
          });
        });
        return task;
      }

      if (toColumn === "done" && store.clearDoneTransientFields(task)) {
        task.updatedAt = new Date().toISOString();
        await store.atomicWriteTaskJson(dir, task);
        if (store.isWatching) store.taskCache.set(id, { ...task });
        store.emit("task:updated", task);
      }
      if (toColumn === "done") {
        await store.clearNearDuplicateReferencesToFailSoft(id, {
          column: "done",
          reason: "done",
        });
      }
      return task;
    }

    const fromColumn = task.column;

    if (useWorkflow && workflowIr) {
      // ── Flag-ON validation + sync guards (typed rejections, KTD-3/R13) ─────
      // 1. Target column must exist in the task's workflow → unknown-column.
      //    #1411: a recoveryRehome move to a LEGACY column (todo/archived/…) is
      //    the engine's self-healing rescue path — those targets are guaranteed
      //    safe landing columns even when a custom workflow never defined them.
      //    recoveryRehome already skips adjacency (below); it must likewise skip
      //    the unknown-column rejection for legacy recovery targets, otherwise a
      //    custom-workflow card could never be rescued to todo/archived and would
      //    stay stuck — the exact bug #1411 describes. Non-legacy unknown targets
      //    still reject (a genuine programming error), and normal (non-recovery)
      //    moves are unaffected.
      const recoveryToLegacy =
        options?.recoveryRehome === true && (COLUMNS as readonly string[]).includes(toColumn);
      if (!workflowHasColumn(workflowIr, toColumn) && !recoveryToLegacy) {
        throw new TransitionRejectionError(
          makeTransitionRejection(
            "unknown-column",
            "transition.rejected.unknownColumn",
            false,
            `Column '${toColumn}' is not defined in this task's workflow`,
          ),
          `Invalid transition: '${fromColumn}' → '${toColumn}'. Unknown column for this workflow.`,
        );
      }
      // 2. Column-graph adjacency. For the default workflow this reproduces
      //    VALID_TRANSITIONS verbatim (resolveAllowedColumns); the
      //    transition-parity suite machine-checks the equivalence. A U5 recovery
      //    re-home (recoveryRehome) skips this so a stranded card can reach its
      //    new workflow's entry column from any current column.
      const allowed = resolveAllowedColumns(workflowIr, fromColumn);
      if (options?.recoveryRehome !== true && !allowed.includes(toColumn)) {
        throw new TransitionRejectionError(
          makeTransitionRejection(
            "guard-rejected",
            "transition.rejected.invalidTransition",
            false,
            `Valid targets: ${allowed.join(", ") || "none"}`,
          ),
          `Invalid transition: '${fromColumn}' → '${toColumn}'. ` +
            `Valid targets: ${allowed.join(", ") || "none"}`,
        );
      }
      const skipWorkflowMovePolicies = store.shouldSkipWorkflowMovePolicies({
        fromColumn,
        toColumn,
        moveSource,
        bypassGuards,
        options,
      });
      if (!skipWorkflowMovePolicies) {
        if (
          internal.movePolicyPreflight?.fromColumn !== fromColumn ||
          internal.movePolicyPreflight?.toColumn !== toColumn ||
          internal.movePolicyPreflight?.workflowSignature !== serializeWorkflowIr(workflowIr)
        ) {
          throw new TransitionRejectionError(
            makeTransitionRejection(
              "guard-rejected",
              "transition.rejected.workflowMovePolicy",
              true,
              "Workflow move policy preflight is stale; retry the move",
            ),
            `Cannot move ${id} to '${toColumn}': workflow move policy preflight is stale`,
          );
        }
      }
      // ── KTD-5: shared transition-policy invariants (single validator) ───────
      // FNXC:WorkflowTransitionPolicy 2026-07-18-19:55:
      // Every mover funnels through here. The structural invariants (merge-blocker
      // on complete-bound entry; terminal→wip re-entry) live in the pure
      // workflow-transition-policy module so graph, scheduler, self-healing,
      // operator, and dashboard moves all reject identically. Merge-blocker
      // enforcement preserves the legacy bypass contract (engine/recovery moves
      // that set bypassGuards/skipMergeBlocker are trusted to have proven the
      // blocker clear — the finalizer's proven-merge path), so the blocker fact is
      // only resolved when NOT bypassed. Terminal→wip re-entry is a new capability
      // invariant that holds for all movers (builtin:coding never crosses it, so
      // the characterization oracle stays byte-identical).
      //
      // FNXC:WorkflowTransitionPolicy 2026-07-19-10:20:
      // The blocker fact is resolved only when the SOURCE column carries the
      // `merge-blocker` trait flag — the trait-level generalization of the legacy
      // `fromColumn === "in-review"` gate. Resolving it for every complete-bound
      // move re-hardcoded the review lane: `getTaskMergeBlocker` rejects any
      // source column that is not literally "in-review", which broke the
      // six-column benchmark's merging → done edge and the builtin
      // in-progress → done mission-validation edge that legacy allowed unchecked.
      // The column-identity precondition inside `getTaskMergeBlocker` is
      // skipped via the explicit `skipColumnIdentityCheck` option (PR #2341
      // review — previously this spoofed `column: "in-review"`, which would
      // silently misapply any future column-dependent logic there): the
      // fromFacts `mergeBlocker` flag IS the workflow's review-lane identity,
      // so only the content checks (paused / blocking status / incomplete
      // steps / pre-merge step results) decide. For builtin:coding this is
      // byte-identical — its only merge-blocker column is literally
      // "in-review".
      {
        const fromFacts = resolveTransitionColumnFacts(workflowIr, fromColumn);
        const toFacts = resolveTransitionColumnFacts(workflowIr, toColumn);
        const mergeBlockerReason =
          !bypassGuards && toFacts.flags.complete && fromFacts.flags.mergeBlocker === true
            ? (getTaskMergeBlocker(task, { skipColumnIdentityCheck: true }) ?? null)
            : null;
        const decision = evaluateTransitionInvariants({
          taskId: id,
          from: fromFacts,
          to: toFacts,
          mergeBlockerReason,
        });
        if (!decision.allow) {
          throw new TransitionRejectionError(
            decision.rejection,
            `Cannot move ${id} to '${toColumn}': ${decision.rejection.detail ?? decision.rejection.code}`,
          );
        }
      }
      // 4. Sync trait guards (in-lock) — plugin gate re-check. Skipped entirely
      //    when bypassGuards (engine/recovery moves, KTD-9).
      if (!bypassGuards) {
        // 4. Plugin gate verdict re-check (U8, KTD-2). For each PLUGIN gate trait
        //    on the target column, consume the pre-evaluated verdict (recorded by
        //    the engine's trait adapter outside the lock). A blocking gate with
        //    no recorded `allow` verdict fails closed (typed rejection); advisory
        //    gates record-and-allow. Built-in gates are handled by their own
        //    path; this guard is the plugin gate surface only.
        const registry = getTraitRegistry();
        const pluginGates = resolveColumnPluginGates(
          findWorkflowColumn(workflowIr, toColumn),
          (tid) => registry.getTrait(tid),
        );
        if (pluginGates.length > 0) {
          const recorded = store.consumePluginGateVerdicts(id, toColumn);
          const byTrait = new Map(recorded.map((v) => [v.traitId, v]));
          for (const gate of pluginGates) {
            if (gate.gateMode === "advisory") continue; // record-and-allow
            // Degraded (force-disabled) plugin gate: its hook impl is gone, so
            // the registry resolves it to a no-op + audit warning (KTD-7). A
            // degraded gate is PASSIVE — the column never blocks the card; the
            // registry's warning is the audit signal. Cards remain movable.
            const resolved = registry.resolveTraitHook(gate.traitId, "gate");
            if (resolved.warning) continue;
            const verdict = byTrait.get(gate.traitId);
            // Fail closed: a blocking gate with no recorded allow verdict rejects.
            if (!verdict || !verdict.allow) {
              const reason =
                verdict?.detail ??
                (verdict
                  ? `Gate '${gate.traitId}' did not pass`
                  : `Gate '${gate.traitId}' has not been evaluated for this move`);
              throw new TransitionRejectionError(
                makeTransitionRejection(
                  "merge-blocked",
                  "transition.rejected.gateBlocked",
                  true,
                  reason,
                ),
                `Cannot move ${id} to '${toColumn}': ${reason}`,
              );
            }
          }
        }
      }
    } else {
      // ── Flag-OFF legacy path (unchanged) ───────────────────────────────────
      // A task can sit in a custom column when the flag was toggled ON→OFF;
      // `VALID_TRANSITIONS` only keys the legacy columns, so a missing entry
      // degrades to the legacy "Invalid transition" error instead of a TypeError.
      // #1409: flag-OFF evacuation. A recoveryRehome move OUT of a non-legacy
      // (custom) column into a legacy target is the ON→OFF evacuation path —
      // `VALID_TRANSITIONS` never keys a custom source column, so the legacy
      // check below would strand the card forever. Allow it through (bypassing
      // only the adjacency check; this is unreachable for normal flag-OFF moves,
      // which never set recoveryRehome and always start from a legacy column, so
      // characterization behavior is byte-identical).
      const sourceIsLegacy = (COLUMNS as readonly string[]).includes(task.column);
      const isEvacuation =
        options?.recoveryRehome === true &&
        !sourceIsLegacy &&
        (COLUMNS as readonly string[]).includes(toColumn);
      /*
      FNXC:AutoMergeLifecycle 2026-07-07-12:00:
      Signature 1 (FN-7641 / NEXT-010): a proven-merge recovery rehome can also run
      LEGACY -> LEGACY (e.g. `todo -> done` when finalizeProvenAutoMergeTask reaches a
      task whose column drifted to `todo`/`in-progress`/`triage` before workspace-merge
      finalization runs). VALID_TRANSITIONS['todo'] never lists 'done' -- that adjacency
      graph encodes the NORMAL flow, not proven-merge recovery -- so the legacy adjacency
      check below rejected the finalizer's `store.moveTask(id, 'done', { recoveryRehome:
      true, preserveProgress: true })` call with "Invalid transition: 'todo' -> 'done'.
      Valid targets: in-progress, triage, archived", stranding the card in `todo` forever
      even though `finalizeProvenAutoMergeTask` already verified `hasDurableMergeProof`
      and `getTaskHardMergeBlocker` before calling moveTask. Bypass ONLY the adjacency
      check for a recoveryRehome move between two legacy columns; the merge-blocker guard
      below (fromColumn === 'in-review' && toColumn === 'done') and the finalizer's own
      hard-blocker gate are untouched, so non-recovery moves and genuine merge blockers
      are not weakened.
      */
      const isLegacyRecoveryRehome =
        options?.recoveryRehome === true &&
        sourceIsLegacy &&
        (COLUMNS as readonly string[]).includes(toColumn);
      /*
      FNXC:WorkflowColumns 2026-07-13-11:50 (merge port from main):
      Third recoveryRehome carve-out: a recovery move INTO a custom column the task's OWN
      workflow declares (e.g. the integrity pass re-homing a workflow-edit orphan to a custom
      entry column). The two carve-outs above only cover legacy targets, so every
      custom-target repair threw the legacy "Invalid transition" Error, which rehomeOccupant
      swallowed as moved:false — the repair silently no-oped on every store open.
      Recovery-only, so normal moves keep the characterization contract byte-identical.
      */
      // Backend-aware IR resolution (resolveTaskWorkflowIrForMove): upstream's
      // sync resolver falls back to builtin:coding in PG mode, which would make
      // this carve-out silently never fire for custom columns on the default
      // backend — the exact bug it exists to fix.
      const isWorkflowDeclaredRecoveryRehome =
        options?.recoveryRehome === true &&
        !(COLUMNS as readonly string[]).includes(toColumn) &&
        workflowHasColumn(await resolveTaskWorkflowIrForMove(store, id), toColumn);
      if (!isEvacuation && !isLegacyRecoveryRehome && !isWorkflowDeclaredRecoveryRehome) {
        /*
        FNXC:WorkflowColumns 2026-07-05-19:30:
        Workflow columns graduated to always-on (no experimental flag emitted), so this "flag-OFF"
        branch is the DEFAULT move path for nearly every project — the strict compat flag reads false
        because nothing sets it. Legacy columns (triage/todo/in-progress/in-review/done/archived) are
        validated verbatim by VALID_TRANSITIONS, preserving the legacy bare-Error contract. But a task
        can legitimately sit in a NON-legacy workflow column now (e.g. Coding (Ideas) → "ideas"), which
        VALID_TRANSITIONS cannot key — the old code returned `?? []` and rejected EVERY move out of it
        ("Invalid transition: 'ideas' → 'todo'. Valid targets: none"). Resolve a non-legacy source
        column's targets from the task's own workflow adjacency instead, still throwing the same
        legacy-style bare Error (not TransitionRejectionError) so the flag-OFF characterization contract
        holds for legacy columns. Ported from main's FN-7591 fix into the extracted moves.ts.
        */
        const validTargets = sourceIsLegacy
          ? (VALID_TRANSITIONS[task.column as Column] ?? [])
          : resolveAllowedColumns(await resolveTaskWorkflowIrForMove(store, id), task.column);
        if (!validTargets.includes(toColumn as Column)) {
          throw new Error(
            `Invalid transition: '${task.column}' → '${toColumn}'. ` +
              `Valid targets: ${validTargets.join(", ") || "none"}`,
          );
        }
      }

      if (fromColumn === "in-review" && toColumn === "done" && !options?.skipMergeBlocker) {
        const mergeBlocker = getTaskMergeBlocker(task);
        if (mergeBlocker) {
          throw new Error(`Cannot move ${id} to done: ${mergeBlocker}`);
        }
      }
    }

    /*
    FNXC:TaskMovement 2026-07-18-14:32:
    A user in-progress -> todo move is a hard cancel. Run the engine-owned,
    store-scoped disposer after every transition guard passes but before the
    task object or durable row changes column. The dashboard cannot observe a
    Todo row until the agent, workflow, configured command, and CLI execution
    surfaces have stopped.
    */
    await disposeTaskBeforeMove(store, {
      task,
      from: fromColumn,
      to: toColumn,
      source: moveSource,
    });

    const movedAt = internal.now ?? new Date().toISOString();
    task.column = toColumn;
    task.columnMovedAt = movedAt;
    task.updatedAt = movedAt;

    if (useWorkflow) {
      // ── Flag-ON: route the legacy per-column side effects through the
      //    default-workflow trait hooks (timing, reset-on-entry, abort-on-exit,
      //    merge.onEnter). "Moved, not duplicated" applies to this path; the
      //    flag-off branch below keeps the legacy inline code verbatim. ───────
      const ctx: DefaultWorkflowMoveContext = {
        task,
        fromColumn,
        toColumn,
        moveSource,
        bypassGuards,
        movedAt,
        settings: undefined,
        options: {
          preserveStatus: options?.preserveStatus,
          preserveResumeState: options?.preserveResumeState,
          preserveProgress: options?.preserveProgress,
          preserveWorktree: options?.preserveWorktree,
          preservePause: options?.preservePause,
        },
        resetSteps: () => store.resetAllStepsToPending(task),
      };
      const isReopenToTodoOrTriage =
        (fromColumn === "in-progress" || fromColumn === "done" || fromColumn === "in-review") &&
        (toColumn === "todo" || toColumn === "triage");
      const hasNonPendingStepProgress = task.steps.some((step) => step.status !== "pending");
      const preserveStepProgress =
        options?.preserveResumeState ||
        (options?.preserveProgress === true && hasNonPendingStepProgress);
      const { warnings } = applyDefaultWorkflowMoveEffects(ctx);
      for (const warning of warnings) {
        storeLog.warn("Default-workflow trait hook degraded to no-op", {
          phase: "moveTaskInternal:workflow-hooks",
          taskId: id,
          ...warning,
        });
      }
      // Store-owned effects the hooks intentionally do NOT perform (filesystem /
      // store-private): clearing done transient fields + prompt-checkbox reset.
      if (toColumn === "done") {
        store.clearDoneTransientFields(task);
      }
      if (isReopenToTodoOrTriage && !preserveStepProgress) {
        await store.resetPromptCheckboxes(dir);
      }
    } else {
      // ── Flag-OFF legacy inline side effects (UNCHANGED — the flag-off path) ──
      if (fromColumn === "in-progress" && toColumn !== "in-progress") {
        const segmentStartMs = Date.parse(task.executionStartedAt ?? task.columnMovedAt);
        const segmentEndMs = Date.parse(task.columnMovedAt);
        const segmentDeltaMs =
          Number.isFinite(segmentStartMs) && Number.isFinite(segmentEndMs)
            ? Math.max(0, segmentEndMs - segmentStartMs)
            : 0;
        task.cumulativeActiveMs = Math.max(0, task.cumulativeActiveMs ?? 0) + segmentDeltaMs;
      }

      if (toColumn === "in-progress") {
        task.cumulativeActiveMs ??= 0;
        if (!task.firstExecutionAt) {
          task.firstExecutionAt = task.columnMovedAt;
        }
        if (!task.executionStartedAt) {
          task.executionStartedAt = task.columnMovedAt;
        }
        task.userPaused = undefined;
      }
      if (toColumn === "done" && !task.executionCompletedAt) {
        task.executionCompletedAt = task.columnMovedAt;
      }

      if (toColumn === "done") {
        store.clearDoneTransientFields(task);
      }

      const isReopenToTodoOrTriage =
        (fromColumn === "in-progress" || fromColumn === "done" || fromColumn === "in-review")
        && (toColumn === "todo" || toColumn === "triage");

      if (isReopenToTodoOrTriage) {
        // FNXC:WorkflowLifecycle 2026-07-12-09:05 (merge port from main): keep
        // this flag-OFF inline block in sync with applyResetOnEntryEffects
        // (default-workflow-hooks.ts) — `preservePause` keeps a pause-caused
        // teardown move from clearing the user's park (FN-7851 pause-bounce loop).
        if (!options?.preserveStatus) {
          task.status = undefined;
          task.error = undefined;
          if (!options?.preservePause) {
            task.pausedReason = undefined;
          }
        }
        task.blockedBy = undefined;
        task.overlapBlockedBy = undefined;
        if (!options?.preservePause) {
          task.paused = undefined;
          task.pausedByAgentId = undefined;
        }
        if (moveSource === "user" && toColumn === "todo") {
          task.userPaused = true;
        } else if (!options?.preservePause) {
          task.userPaused = undefined;
        }

        const hasNonPendingStepProgress = task.steps.some((step) => step.status !== "pending");
        const preserveStepProgress =
          options?.preserveResumeState || (options?.preserveProgress === true && hasNonPendingStepProgress);

        if (!options?.preserveWorktree) {
          task.worktree = undefined;
        }

        if (!options?.preserveResumeState) {
          task.executionStartedAt = undefined;
          task.executionCompletedAt = undefined;
        } else {
          task.executionCompletedAt = undefined;
        }

        if (!preserveStepProgress) {
          store.resetAllStepsToPending(task);
          await store.resetPromptCheckboxes(dir);
        }
      }

      if (toColumn === "in-review") {
        // Keep this flag-OFF inline path in sync with applyInReviewEnterEffects.
        // Do not snapshot global autoMerge: undefined follows the live setting,
        // while explicit per-task true/false overrides remain sticky.
        task.recoveryRetryCount = undefined;
        task.nextRecoveryAt = undefined;
        // Clear scheduler-side dispatch state: `queued`, `blockedBy`, and
        // `overlapBlockedBy` are stamped while the task waits in `todo`. If
        // they survive the transition into `in-review` they permanently block
        // the merge gate (see getTaskMergeBlocker's BLOCKING_TASK_STATUSES).
        if (task.status === "queued") {
          task.status = undefined;
        }
        task.blockedBy = undefined;
        task.overlapBlockedBy = undefined;
      }

      if (
        (fromColumn === "in-review" && (toColumn === "todo" || toColumn === "in-progress" || toColumn === "triage"))
        || (fromColumn === "done" && (toColumn === "todo" || toColumn === "triage"))
      ) {
        task.workflowStepResults = undefined;
      }

      if (fromColumn === "in-review" && (toColumn === "todo" || toColumn === "triage")) {
        task.branch = undefined;
        task.executionStartBranch = undefined;
        task.baseCommitSha = undefined;
        task.summary = undefined;
        task.recoveryRetryCount = undefined;
        task.nextRecoveryAt = undefined;
      }
    }

    if (toColumn === "in-progress" && !task.worktree && options?.allocateWorktree) {
      const allocator = options.allocateWorktree;
      const allocated = await store.withWorktreeAllocationLock(async () => {
        const others = await store.listTasks({ slim: true, includeArchived: false });
        const reservedNames = new Set<string>();
        for (const other of others) {
          if (other.id === id || !other.worktree) continue;
          const name = other.worktree.split("/").filter(Boolean).pop();
          if (name) reservedNames.add(name);
        }
        return allocator(reservedNames);
      });
      if (allocated) {
        task.worktree = allocated;
      }
    }

    let deletedAt: string | undefined;
    let alreadyEnqueued = false;
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:30:
    // Backend-mode main move transaction: use layer.transactionImmediate with
    // async in-transaction helpers. The capacity check, upsert, audit,
    // dequeue/enqueue all run inside the async transaction so they commit or
    // roll back atomically (VAL-DATA-002/003/013). The transition guards and
    // side effects above are pure JS and already ran unchanged.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const context = store.createTaskPersistSerializationContext(task);
      await layer.transactionImmediate(async (tx) => {
        // Capacity check (KTD-10). In backend mode, count active tasks in the
        // target column via async Drizzle instead of the sync helper.
        if (useWorkflow && workflowIr && fromColumn !== toColumn) {
          const capacity = resolveColumnCapacity(workflowIr, toColumn, mergedSettingsForMove);
          if (capacity.hasCapacity && Number.isFinite(capacity.limit)) {
            // Shared pooled-budget enforcement (see enforcePooledColumnCapacity);
            // this path supplies the async in-transaction counter.
            await enforcePooledColumnCapacity({
              workflowIr,
              toColumn,
              taskId: id,
              capacity,
              countOccupants: (budgetColumn, countPending) =>
                store.countActiveInCapacitySlotAsync({
                  tx,
                  targetColumn: budgetColumn,
                  workflowId: effectiveWorkflowIdForMove,
                  countPending,
                  excludeTaskId: id,
                }),
            });
          }
        }

        // Upsert the task row (update column + all mutated fields).
        // FNXC:MultiProjectIsolation 2026-07-10: pass the bound projectId (stamped
        // on insert, preserved on update) so partitioning survives moves.
        await upsertTaskRowInTransaction(tx, task as unknown as Record<string, unknown>, context, layer.projectId);

        // U4 (flag-ON) parity with the SQLite branch below: write the
        // crash-safe transitionPending marker in the SAME transaction as the
        // column change (KTD-2). countActiveInCapacitySlotAsync already counts
        // pending markers in PG, so this is load-bearing for capacity too.
        if (useWorkflow) {
          await writeTransitionPendingAsync(
            tx,
            id,
            makeTransitionPending(toColumn, ["default-workflow:postCommit"], Date.parse(movedAt) || Date.now()),
          );
        }

        // Audit: task:move
        await recordRunAuditEventWithinTransaction(tx, {
          taskId: id,
          agentId: internal.runContext?.agentId ?? "system",
          runId: internal.runContext?.runId ?? "unknown",
          domain: "database",
          mutationType: "task:move",
          target: id,
          metadata: {
            from: fromColumn,
            to: toColumn,
            moveSource,
          },
        });

        // Dequeue from merge queue on column exit (if leaving in-review).
        await dequeueMergeQueueOnColumnExitInTransaction(tx, id, fromColumn, toColumn, movedAt);

        if (toColumn === "in-review" && !internal.fromHandoff && options?.allowDirectInReviewMove !== true) {
          await recordRunAuditEventWithinTransaction(tx, {
            taskId: id,
            agentId: internal.runContext?.agentId ?? "system",
            runId: internal.runContext?.runId ?? "unknown",
            domain: "database",
            mutationType: "task:handoff-invariant-violation",
            target: id,
            metadata: {
              taskId: id,
              fromColumn,
              callerStack: new Error().stack?.split("\n").slice(0, 8).join("\n"),
            },
          });
        }

        if (internal.fromHandoff) {
          const existingRows = await tx
            .select({ one: sql`1` })
            .from(schema.project.mergeQueue)
            .where(eq(schema.project.mergeQueue.taskId, id))
            .limit(1);
          alreadyEnqueued = existingRows.length > 0;
          await enqueueMergeQueueInTransaction(tx, id, { priority: task.priority, now: internal.now }, {
            agentId: internal.runContext?.agentId,
            runId: internal.runContext?.runId,
          });
          // FNXC:PostgresCutover 2026-06-27-10:25:
          // Thread the outer move transaction so cancel + upsert commit
          // atomically with the handoff (no orphaned merge-gate items on rollback).
          await store.createCompletionHandoffWorkflowWork(task, {
            runId: internal.runContext?.runId,
            now: internal.now,
            source: internal.evidence?.reason,
          }, tx);
          await recordRunAuditEventWithinTransaction(tx, {
            taskId: id,
            agentId: internal.runContext?.agentId ?? "system",
            runId: internal.runContext?.runId ?? "unknown",
            domain: "database",
            mutationType: "task:handoff",
            target: id,
            metadata: {
              taskId: id,
              fromColumn,
              ownerAgentId: internal.ownerAgentId ?? null,
              reason: internal.evidence?.reason,
              runId: internal.runContext?.runId,
              agentId: internal.runContext?.agentId,
              alreadyEnqueued,
            },
          });
          /*
          FNXC:HandoffFailureInjection 2026-07-15-12:00:
          Backend handoffs bypass the legacy enqueueMergeQueueSyncInternal spy.
          This test-only no-op seam runs after every VAL-DATA-013 sub-write
          (move, queue, workflow work, and handoff audit), so an injected throw
          proves this transaction rolls all of them back.
          */
          await store.__invokeHandoffMergeQueueFailureInjectorForTesting(id);
        }
      });
    } else {
    store.db.transactionImmediate(() => {
      deletedAt = store.getSoftDeletedWriteConflict(id, task);
      if (deletedAt) {
        return;
      }

      // ── U6: in-txn capacity enforcement (KTD-10) ──────────────────────────
      // WIP limits are trait *config*; enforcement is a substrate capability
      // that runs HERE, inside the move transaction, so two holds releasing into
      // one slot serialize — exactly one commits, the other rejects and retries
      // next sweep. It is NOT a guard: it runs regardless of bypassGuards /
      // recoveryRehome / moveSource (engine/recovery/scheduler moves honor it
      // too). Only a real column change into a capacity-bearing column is gated;
      // same-column no-ops were returned earlier. The count is taken with the
      // moving task EXCLUDED and the prospective slot it is about to occupy
      // added back implicitly (it must fit alongside existing holders), so a
      // full column (occupants == limit) rejects.
      if (useWorkflow && workflowIr && fromColumn !== toColumn) {
        const capacity = resolveColumnCapacity(workflowIr, toColumn, mergedSettingsForMove);
        if (capacity.hasCapacity && Number.isFinite(capacity.limit)) {
          // Shared pooled-budget enforcement (see enforcePooledColumnCapacity);
          // the sync counter keeps count → verdict → throw fully synchronous
          // inside this sync transaction callback.
          enforcePooledColumnCapacity({
            workflowIr,
            toColumn,
            taskId: id,
            capacity,
            countOccupants: (budgetColumn, countPending) =>
              store.countActiveInCapacitySlotSync({
                targetColumn: budgetColumn,
                workflowId: effectiveWorkflowIdForMove,
                countPending,
                excludeTaskId: id,
              }),
          });
        }
      }

      store.upsertTaskWithFtsRecovery(task);
      store.insertRunAuditEventRow({
        taskId: id,
        agentId: internal.runContext?.agentId,
        runId: internal.runContext?.runId,
        domain: "database",
        mutationType: "task:move",
        target: id,
        metadata: {
          from: fromColumn,
          to: toColumn,
          moveSource,
        },
      });
      store.dequeueMergeQueueOnColumnExit(id, fromColumn, toColumn, movedAt);

      // U4 (flag-ON): write the crash-safe transitionPending marker in the SAME
      // transaction as the column change (KTD-2). It records the post-commit
      // hooks that still owe idempotent execution so a crash mid-transition is
      // recoverable from SQLite (the authoritative store, ADR-0001). The store
      // clears it immediately after the post-commit hook runner completes
      // (below). For the default workflow the field effects already applied
      // in-lock; the marker guards the post-commit completion so recovery never
      // double-runs (idempotent) and never strands the card.
      if (useWorkflow) {
        writeTransitionPending(
          store.db,
          id,
          makeTransitionPending(toColumn, ["default-workflow:postCommit"], Date.parse(movedAt) || Date.now()),
        );
      }

      if (toColumn === "in-review" && !internal.fromHandoff && options?.allowDirectInReviewMove !== true) {
        store.insertRunAuditEventRow({
          taskId: id,
          agentId: internal.runContext?.agentId,
          runId: internal.runContext?.runId,
          domain: "database",
          mutationType: "task:handoff-invariant-violation",
          target: id,
          metadata: {
            taskId: id,
            fromColumn,
            callerStack: new Error().stack?.split("\n").slice(0, 8).join("\n"),
          },
        });
      }

      if (internal.fromHandoff) {
        alreadyEnqueued = Boolean(store.db.prepare("SELECT 1 FROM mergeQueue WHERE taskId = ?").get(id));
        store.enqueueMergeQueueSyncInternal(id, { priority: task.priority, now: internal.now });
        store.createCompletionHandoffWorkflowWork(task, {
          runId: internal.runContext?.runId,
          now: internal.now,
          source: internal.evidence?.reason,
        });
        store.insertRunAuditEventRow({
          taskId: id,
          agentId: internal.runContext?.agentId,
          runId: internal.runContext?.runId,
          domain: "database",
          mutationType: "task:handoff",
          target: id,
          metadata: {
            taskId: id,
            fromColumn,
            ownerAgentId: internal.ownerAgentId ?? null,
            reason: internal.evidence?.reason,
            runId: internal.runContext?.runId,
            agentId: internal.runContext?.agentId,
            alreadyEnqueued,
          },
        });
      }
    });
    } // end of else (non-backend sync path)

    if (deletedAt) {
      if (internal.fromHandoff) {
        throw new HandoffInvariantViolationError(
          id,
          fromColumn,
          `Cannot hand off ${id} to in-review because the task is deleted`,
        );
      }
      store.throwSoftDeletedWriteBlocked(id, deletedAt, "moveTaskInternal", {
        agentId: internal.runContext?.agentId,
        runId: internal.runContext?.runId,
        timestamp: movedAt,
      });
    }

    await store.writeTaskJsonFile(dir, task);
    if (fromColumn === "in-review" && toColumn === "todo" && moveSource === "user") {
      const handoffAccepted = await store.getCompletionHandoffAcceptedMarker(id);
      const mergeRequest = await store.getMergeRequestRecordAsync(id);
      if (handoffAccepted && mergeRequest && mergeRequest.state !== "succeeded" && mergeRequest.state !== "cancelled") {
        if (mergeRequest.state === "queued" || mergeRequest.state === "running" || mergeRequest.state === "retrying" || mergeRequest.state === "manual-required") {
          await store.transitionMergeRequestState(id, "cancelled", {
            attemptCount: mergeRequest.attemptCount,
            lastError: mergeRequest.lastError ?? "cancelled-by-user-hard-cancel",
          });
        }
      }
      void store.cancelActiveWorkflowWorkItemsForTask(id, {
        kinds: ["merge", "manual-hold"],
        now: movedAt,
        lastError: "cancelled-by-user-hard-cancel",
      });
      void store.clearCompletionHandoffAcceptedMarker(id);
    }
    if (toColumn === "done") {
      // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-16:00:
      // Backend mode: clearLinkedAgentTaskIds is a sync SQLite operation; skip
      // it in backend mode (the agent cleanup is best-effort and handled by
      // the async satellite stores when needed).
      if (!store.backendMode) {
        store.clearLinkedAgentTaskIds(id, task.updatedAt);
      }
    }

    if (store.isWatching) store.taskCache.set(id, { ...task });

    // U4 (flag-ON): post-commit hook completion. The default-workflow field
    // effects already ran in-lock and committed; the post-commit phase here is
    // the fire-and-forget hook runner per KTD-2. It is idempotent and clears the
    // transitionPending marker once done. A crash before this point leaves the
    // marker for the recovery sweep to re-run (re-running is a no-op for the
    // default workflow's already-committed field effects).
    //
    // Residual C (U8): AFTER the built-in effects, invoke registered PLUGIN
    // onExit (from column) / onEnter (to column) trait hook impls, recording
    // per-hook completion in the marker's hooksRemaining. A throwing plugin hook
    // DEGRADES (audit) and never wedges the lock or strands the marker — the
    // marker is always cleared at the end regardless of hook failures.
    if (useWorkflow) {
      // Plugin hooks are skipped on engine/recovery-sourced moves (KTD-9 — those
      // bypass trait effects) and on same-column no-ops.
      if (!bypassGuards && fromColumn !== toColumn && workflowIr) {
        try {
          await store.runPluginColumnTransitionHooks(id, workflowIr, fromColumn, toColumn);
        } catch (err) {
          // The runner itself swallows per-hook failures; this is a final guard
          // so a runner-level fault never strands the marker.
          storeLog.warn("Plugin column transition hook runner faulted (degraded)", {
            phase: "moveTaskInternal:plugin-hooks",
            taskId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      try {
        if (store.backendMode) {
          await clearTransitionPendingAsync(store.asyncLayer!.db, id);
        } else {
          clearTransitionPending(store.db, id);
        }
      } catch {
        // Clearing is best-effort; the marker recovery sweep is the backstop.
      }
    }

    if (fromColumn !== toColumn) {
      store.emit("task:moved", { task, from: fromColumn, to: toColumn, source: moveSource });
    }
    if (toColumn === "done") {
      await store.clearNearDuplicateReferencesToFailSoft(id, {
        column: "done",
        reason: "done",
      });
    }
    return task;
  }
