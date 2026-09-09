/**
 * update-task-deps operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog, type TaskDependencyMutation} from "../store.js";
import {buildRefinementSeedPrompt} from "../mesh/mesh-task-replication.js";
import {resolveDependencyReplanTarget, resolveLifecycleColumns, toTaskMoveLanes} from "../workflows/workflow-lifecycle-traits.js";
import {resolveWorkflowIrForTask} from "../workflows/workflow-ir-resolver.js";
import {SelfDefeatingDependencyError, SelfSpawnedDependencyError, detectSelfDefeatingDependency, detectSelfSpawnedDependency} from "./errors.js";
import {resolveTaskLifecycleColumns} from "../workflows/workflow-lifecycle-traits.js";
import {resolveWorkflowIntakeFacts} from "./task-creation.js";
import type {WorkflowIr} from "../workflows/workflow-ir-types.js";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {existsSync} from "node:fs";
import type {Task, Column, RunMutationContext, RunAuditEventInput} from "../types.js";
import "../builtin-traits.js";
import {normalizeTaskPriority} from "../tasks/task-priority.js";
import {extractTaskIdTokens, normalizeTitleForTaskId} from "../tasks/task-title-id-drift.js";
import {generateTaskLineageId} from "../tasks/task-lineage.js";
import {deriveFallbackTaskTitle} from "../ai/ai-summarize.js";
import {sanitizeFileScopeInPromptContent} from "../task-store/file-scope.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {supersedePlanReviewResults} from "../planner/plan-approval.js";
import {writePromptFileAtomic} from "./prompt-file.js";

export async function refineTaskImpl(store: TaskStore, id: string, feedback: string): Promise<Task> {
    const sourceTask = await store.getTask(id);

    /*
    FNXC:WorkflowLifecycleColumns 2026-08-02-02:10 (fleet: task-store dependency + refine guards):
    REFINE IS ALLOWED FROM THE BOARD'S COMPLETE OR REVIEW LANE. Spelled as literals, `fn_task_refine` was
    unavailable on every renamed board — and the error text named two columns the operator does not have,
    which sends them looking for a column that does not exist. The message now names the real ones.
    */
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-02-02:50 (the LEGACY-ROW union, and the existing suite caught it):
    UNIONED WITH THE LEGACY IDS, because a row can outlive the column it is stored in. My first version
    compared ONLY the resolved lanes, and `refine-duplicate-task.pg.test.ts` immediately failed with
    "task is in 'done', must be in 'published' or 'editorial-review'" — a row sitting in `done` on a board
    that declares `published`. That row is real (U11 leaves exactly this shape behind), and refusing an
    operator action on it is a worse outcome than accepting one extra column name.

    OVER-INCLUSION IS THE SAFE DIRECTION HERE: this gate answers "may the operator refine this?", so being
    too permissive occasionally allows a refine from a column that is not really terminal, while being too
    strict makes `fn_task_refine` unavailable for a legitimately finished task with no recourse. Same
    reasoning, and the same union, as `resolveTerminalColumnsFor` in the executor.
    */
    const refineLifecycle = await resolveTaskLifecycleColumns(store, id);
    const refineFrom = [...new Set([
      refineLifecycle?.complete ?? "done",
      refineLifecycle?.review ?? "in-review",
      "done",
      "in-review",
    ])];
    if (!refineFrom.includes(sourceTask.column)) {
      throw new Error(
        `Cannot refine ${id}: task is in '${sourceTask.column}', must be in ${refineFrom.map((c) => `'${c}'`).join(" or ")}`,
      );
    }

    if (!feedback?.trim()) {
      throw new Error("Feedback is required and cannot be empty");
    }

    const now = new Date().toISOString();
    /*
    FNXC:RefinementTitle 2026-07-26-20:10:
    A refinement is titled by the operator's OWN feedback, exactly as a newly created task is
    titled by its description — not "Refinement: <source title>".
    Requirement it fixes: ten refinements of one task all rendered the identical title, so the
    board could not distinguish them and the only text that says what each one actually asks for
    was buried in the description. The title is the card's scarcest surface; spending it on the
    parent's name made every sibling look the same.
    Provenance is NOT lost — it moves to affordances that do not consume the title: the
    `task_refine` source chip on the card, the parent link in the detail view, and the
    `Refines: <id>` line kept in the description plus the real `dependencies` edge.
    `deriveFallbackTaskTitle` is the same deterministic, never-LLM derivation other titleless
    rows use (first meaningful line, markdown stripped, truncated at a word boundary), so a
    refinement reads like any other card rather than inventing its own truncation rule.
    */
    const refinementTitle = deriveFallbackTaskTitle(feedback.trim());

    /*
     * FNXC:WorkflowOptionalSteps 2026-07-16-00:00:
     * FN-8188 requires refinements to inherit create-time default-workflow seeding so
     * default-on optional groups, including plan-review and code-review, gate them
     * exactly as they gate newly created tasks.
     *
     * FNXC:OriginWorkflowSelection 2026-07-26-19:40:
     * That inheritance is now overridable by the project `refinementTaskWorkflowId`
     * setting (Settings -> Project General). Unset keeps FN-8188's behavior; a pinned
     * id, or the operator's mirrored Board lane, seeds the refinement from THAT
     * workflow instead. The override resolver already degrades a stale/missing/fragment
     * id to `undefined`, so this branch falls back to the project default unchanged.
     */
    let pendingWorkflowSelection: { workflowId: string; stepIds: string[] } | undefined;
    try {
      const override = await store.resolveOriginWorkflowOverrideId("refinement");
      const inherited = override
        ? await store.materializeExplicitWorkflowSteps(override)
        : await store.materializeDefaultWorkflowSteps();
      if (inherited) {
        pendingWorkflowSelection = inherited;
      }
    } catch (err) {
      storeLog.warn("Failed to apply default workflow during refinement task creation", {
        phase: "refineTask:default-workflow",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    /*
    FNXC:RefinementPlanningRouting 2026-08-19-05:26:
    Refinements should be actionable immediately, so a workflow's manual capture lane is bypassed
    when that workflow declares a Planning hold. Automatic workflows retain their intake destination;
    a manual workflow without a usable hold, or any unresolved workflow, preserves the existing
    `triage` fallback. Resolve these facts with the same pending selection that is persisted below so
    placement and workflow selection cannot disagree, and use trait-derived roles rather than column ids.
    */
    const refinementIntakeFacts = await resolveWorkflowIntakeFacts(store, pendingWorkflowSelection?.workflowId);
    const refineIntakeColumn = refinementIntakeFacts.manual
      ? refinementIntakeFacts.hold ?? "triage"
      : refinementIntakeFacts.intake ?? "triage";
    const newTask = await store.createTaskWithDistributedReservation({ description: feedback.trim() }, {
      createTaskWithId: async (newId) => {
        // FN-5077: keep deterministic "Refinement" fallback when normalized refinement label is unusable (null).
        // The id-token strip matters more now that the title comes from free-typed feedback, which
        // routinely names the task being refined ("FN-1234 still drops the badge").
        const normalizedTitle = normalizeTitleForTaskId(refinementTitle, newId);
        if (normalizedTitle.changed) {
          const removed = extractTaskIdTokens(refinementTitle).filter((token) => token !== newId.toUpperCase());
          storeLog.log(`[title-id-drift] normalized title for ${newId}: removed=[${removed.join(",")}]`);
        }
        const sourceGithubLinked = sourceTask.githubTracking?.enabled === true || Boolean(sourceTask.githubTracking?.issue);
        // FN-5780: refinement should inherit source linking intent so unlinked tasks stay opted out from auto-create defaults.
        const refinementGithubTracking = sourceGithubLinked
          ? {
            enabled: true,
            ...(sourceTask.githubTracking?.repoOverride
              ? { repoOverride: sourceTask.githubTracking.repoOverride }
              : {}),
          }
          : { enabled: false };

        const newTask: Task = {
          id: newId,
          lineageId: generateTaskLineageId(),
          title: normalizedTitle.title ?? "Refinement",
          description: `${feedback.trim()}\n\nRefines: ${id}`,
          priority: normalizeTaskPriority(sourceTask.priority),
          column: refineIntakeColumn as Task["column"],
          dependencies: [id],
          sourceType: "task_refine",
          sourceParentTaskId: id,
          githubTracking: refinementGithubTracking,
          steps: [],
          currentStep: 0,
          log: [{ timestamp: now, action: `Created as refinement of ${id}` }],
          columnMovedAt: now,
          createdAt: now,
          updatedAt: now,
          attachments: sourceTask.attachments ? [...sourceTask.attachments] : undefined,
          ...(pendingWorkflowSelection
            ? { enabledWorkflowSteps: pendingWorkflowSelection.stepIds }
            : {}),
        };

        await store.maybeResolveTombstonedTaskId(newId, {}, "refineTask");
        await store.assertTaskIdAvailable(newId);

        const newDir = store.taskDir(newId);
        await store.atomicCreateTaskJson(newDir, newTask, "refineTask");
        // Shared builder: isUnplannedSeedPrompt detects this exact shape so promoted
        // refinements are planned instead of executing the feedback text as a spec.
        const prompt = buildRefinementSeedPrompt(newTask.title ?? newId, newTask.description);
        const sanitizedPrompt = sanitizeFileScopeInPromptContent(prompt);
        await mkdir(newDir, { recursive: true });
        await writePromptFileAtomic(join(newDir, "PROMPT.md"), sanitizedPrompt.sanitized);

        if (sourceTask.attachments && sourceTask.attachments.length > 0) {
          const sourceAttachDir = join(store.taskDir(id), "attachments");
          const targetAttachDir = join(newDir, "attachments");
          await mkdir(targetAttachDir, { recursive: true });
          for (const attachment of sourceTask.attachments) {
            const sourcePath = join(sourceAttachDir, attachment.filename);
            const targetPath = join(targetAttachDir, attachment.filename);
            if (existsSync(sourcePath)) {
              const content = await readFile(sourcePath);
              await writeFile(targetPath, content);
            }
          }
        }

        if (store.isWatching) store.taskCache.set(newId, { ...newTask });
        store.emit("task:created", newTask);
        await store.invokeTaskCreatedHook(newTask);
        return newTask;
      },
    });

    // Record the inherited selection only after its task row exists, matching createTask.
    if (pendingWorkflowSelection) {
      try {
        await store.writeTaskWorkflowSelection(
          newTask.id,
          pendingWorkflowSelection.workflowId,
          pendingWorkflowSelection.stepIds,
        );
      } catch (err) {
        storeLog.warn("Failed to record inherited workflow selection", {
          taskId: newTask.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return newTask;
  }

export async function updateTaskDependenciesImpl(store: TaskStore, id: string, mutation: TaskDependencyMutation, runContext?: RunMutationContext,): Promise<Task> {
  return store.withPlanningLifecycleLock(id, () => updateTaskDependenciesWithTaskLockImpl(store, id, mutation, runContext));
}

async function updateTaskDependenciesWithTaskLockImpl(store: TaskStore, id: string, mutation: TaskDependencyMutation, runContext?: RunMutationContext,): Promise<Task> {
    const updated = await store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const previousDependencies = [...(task.dependencies ?? [])];
      const normalizedCurrent = previousDependencies.map((dependency) => dependency.trim()).filter(Boolean);
      let nextDependencies: string[];
      let action: string;

      const assertNotSelf = (dependencyId: string) => {
        if (dependencyId === id) {
          throw new Error(`Task ${id} cannot depend on itself`);
        }
      };
      /*
       * FNXC:SqliteFinalRemoval 2026-06-26:
       * In backend mode, readTaskFromDb uses store.db (SQLite) which is unavailable.
       * Replace with async store.getTask() calls.
       */
      const assertTaskExists = async (dependencyId: string) => {
        /*
        FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
        Map only not-found/deleted errors to "Dependency task not found"; rethrow transport and other PostgreSQL failures.
        */
        try {
          await store.getTask(dependencyId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not found|TaskDeleted|deleted/i.test(msg)) {
            throw new Error(`Dependency task ${dependencyId} not found`);
          }
          throw err;
        }
      };
      const assertUnique = (dependencies: readonly string[]) => {
        const seen = new Set<string>();
        for (const dependencyId of dependencies) {
          if (seen.has(dependencyId)) {
            throw new Error(`Task ${id} already depends on ${dependencyId}`);
          }
          seen.add(dependencyId);
        }
      };
      const normalizeDependency = async (dependencyId: string, label = "dependency") => {
        const normalized = dependencyId.trim();
        if (!normalized) {
          throw new Error(`${label} is required`);
        }
        assertNotSelf(normalized);
        await assertTaskExists(normalized);
        return normalized;
      };

      switch (mutation.operation) {
        case "add": {
          const dependency = await normalizeDependency(mutation.dependency);
          if (normalizedCurrent.includes(dependency)) {
            throw new Error(`Task ${id} already depends on ${dependency}`);
          }
          nextDependencies = [...normalizedCurrent, dependency];
          action = `Added dependency ${dependency}`;
          break;
        }
        case "remove": {
          const dependency = mutation.dependency.trim();
          if (!dependency) {
            throw new Error("dependency is required");
          }
          if (!normalizedCurrent.includes(dependency)) {
            throw new Error(`Task ${id} does not depend on ${dependency}`);
          }
          nextDependencies = normalizedCurrent.filter((candidate) => candidate !== dependency);
          action = `Removed dependency ${dependency}`;
          break;
        }
        case "replace": {
          const from = mutation.from.trim();
          if (!from) {
            throw new Error("from dependency is required");
          }
          const to = await normalizeDependency(mutation.to, "replacement dependency");
          if (!normalizedCurrent.includes(from)) {
            throw new Error(`Task ${id} does not depend on ${from}`);
          }
          if (from !== to && normalizedCurrent.includes(to)) {
            throw new Error(`Task ${id} already depends on ${to}`);
          }
          nextDependencies = normalizedCurrent.map((dependency) => dependency === from ? to : dependency);
          action = `Replaced dependency ${from} with ${to}`;
          break;
        }
        case "set": {
          const normalized: string[] = [];
          for (const dep of mutation.dependencies) {
            normalized.push(await normalizeDependency(dep));
          }
          nextDependencies = normalized;
          assertUnique(nextDependencies);
          action = nextDependencies.length > 0
            ? `Set dependencies to ${nextDependencies.join(", ")}`
            : "Cleared dependencies";
          break;
        }
      }

      const selfDefeatingDep = detectSelfDefeatingDependency(task.title, nextDependencies);
      if (selfDefeatingDep) {
        throw new SelfDefeatingDependencyError(
          task.title?.trim() ?? "",
          selfDefeatingDep.matchedVerb,
          selfDefeatingDep.operandTaskId,
        );
      }

      await store.assertNoDependencyCycle(
        id,
        nextDependencies,
        "updateTask",
        new Map([[id, nextDependencies]]),
      );

      const previousDependencySet = new Set(normalizedCurrent);
      const newlyAdded = nextDependencies.filter((dependencyId) => !previousDependencySet.has(dependencyId));
      const candidates = (await Promise.all(newlyAdded.map(async (dependencyId) => {
        try { return await store.getTask(dependencyId); } catch { return null; }
      }))).flatMap((candidate) => candidate
        ? [{ id: candidate.id, ...(candidate.sourceParentTaskId ? { sourceParentTaskId: candidate.sourceParentTaskId } : {}) }]
        : []);
      const selfSpawned = detectSelfSpawnedDependency(id, candidates);
      if (selfSpawned) throw new SelfSpawnedDependencyError(id, selfSpawned.dependencyId);
      const hasNewDependencies = newlyAdded.length > 0;
      const dependenciesChanged = normalizedCurrent.length !== nextDependencies.length
        || normalizedCurrent.some((dependency, index) => dependency !== nextDependencies[index]);

      task.dependencies = nextDependencies;
      /*
       * FNXC:SqliteFinalRemoval 2026-06-26:
       * In backend mode, readTaskFromDb is unavailable. Use async getTask instead
       * to resolve unresolved dependency and current blocker columns.
       */
      const readDepTask = async (depId: string): Promise<Task | null> => {
        /*
        FNXC:PostgresCutover 2026-07-31-17:10 (DEADLOCK, same class as PR #2809):
        THE TASK WE ALREADY HOLD THE LOCK FOR IS ALREADY IN SCOPE. This closure runs inside
        `store.withTaskLock(id, ...)` (the wrapper at the top of `updateTaskDependenciesImpl`), and
        `store.getTask()` acquires that same lock — `getTaskImpl` opens with `withTaskLock(id, ...)`
        and the per-task lock is NON-REENTRANT. Re-reading `id` through it waits forever on a lock
        this frame holds.

        REACHED VIA `task.blockedBy`, whose only caller passes exactly that. `blockedBy === id` is
        writable today: `updateTask({ blockedBy })` has no self-reference guard, unlike the
        dependencies list, which rejects `dependencyId === id` a few lines above (that guard is why
        the sibling `assertTaskExists` read on this same lock is safe and is left unchanged).

        Returning the in-lock copy is also strictly more correct than a re-read: it is the state this
        mutation is reasoning about, not whatever a concurrent writer left behind.
        */
        if (depId === id) return task;
        /*
        FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
        Treat not-found as null; rethrow unexpected PostgreSQL failures.
        */
        try {
          return await store.getTask(depId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not found|TaskDeleted|deleted/i.test(msg)) return null;
          throw err;
        }
      };

      /*
      FNXC:WorkflowLifecycleColumns 2026-08-02-02:20:
      A dependency is satisfied only when it reaches its own workflow Complete column. Review remains
      unfinished, while deleted or missing dependencies remain unsatisfied. Historical archive rows are
      re-integrated into Complete during store open rather than treated as a second terminal authority.

      Each dependency resolves through its OWN workflow — dependencies can live on different boards — with
      one shared IR cache for the set. On a renamed board this comparison matched nothing, so EVERY
      dependency read as unresolved and `blockedBy` was set to the first one forever: the dependents never
      unblocked even after the work landed.
      */
      const allDepTasks = await Promise.all(nextDependencies.map(readDepTask));
      const depIrCache = new Map<string, WorkflowIr>();
      const isDependencySatisfied = async (dep: { id: string; column: string } | null): Promise<boolean> => {
        if (!dep) return false;
        const lifecycle = await resolveTaskLifecycleColumns(store, dep.id, depIrCache);
        /*
        Unioned with the built-in Complete fallback for the same reason as the refine gate above: a
        dependency row can still be stored in `done` after its workflow changes, and reading such a row
        as UNSATISFIED would strand dependents.
        */
        /*
        DELIBERATE-LITERAL — reviewed 2026-07-31-02:40. The `done` half of this union is the degraded
        built-in fallback for an unresolvable workflow.
        */
        return dep.column === (lifecycle?.complete ?? "done")
          || dep.column === "done";
      };
      const depSatisfaction = await Promise.all(allDepTasks.map(isDependencySatisfied));
      const unresolvedDependencyIndex = depSatisfaction.findIndex((satisfied) => !satisfied);
      const unresolvedDependency = unresolvedDependencyIndex >= 0 ? nextDependencies[unresolvedDependencyIndex] : undefined;

      if (unresolvedDependency) {
        const currentBlocker = task.blockedBy ? await readDepTask(task.blockedBy) : null;
        const currentBlockerResolved = await isDependencySatisfied(currentBlocker);
        if (!task.blockedBy || !nextDependencies.includes(task.blockedBy) || !currentBlocker || currentBlockerResolved) {
          task.blockedBy = unresolvedDependency;
        }
      } else {
        task.blockedBy = undefined;
      }
      task.updatedAt = new Date().toISOString();
      task.log ??= [];
      let movedToTriage = false;
      /*
      FNXC:WorkflowLifecycleColumns 2026-08-04-06:35 (FN-8768 — GUARD AND DESTINATION together):
      A new dependency on a card still resting in the HOLD lane, or parked after exhausting Plan
      Review in a distinct review column, requests re-specification through the shared lifecycle policy.
      Automatic intakes remain the destination; a manual intake is a capture lane, so the policy uses the
      workflow's HOLD column instead. A workflow with no safe derived target keeps the card where it is.
      */
      /*
      FNXC:DependencyReplanManualIntake 2026-08-19-02:59:
      Resolve the source hold role and automatic replan destination from one IR snapshot. A concurrent
      workflow edit must not combine an old hold role with a new intake/hold destination and write a
      column that neither workflow version selected for this card.
      */
      const respecifyIr = hasNewDependencies
        ? await resolveWorkflowIrForTask(store, id).catch(() => undefined)
        : undefined;
      const respecifyLifecycle = respecifyIr ? resolveLifecycleColumns(respecifyIr) : undefined;
      const holdColumn = respecifyLifecycle?.hold ?? "todo";
      const replanColumn = resolveDependencyReplanTarget(respecifyIr);
      const respecifyFromColumn = task.column;
      const isPlanReviewCapPark = task.status === "awaiting-approval"
        && task.awaitingApprovalReason === "plan-review-replan-cap";
      const shouldRespecify = hasNewDependencies
        && (task.column === holdColumn || isPlanReviewCapPark);
      /*
      FNXC:PlanningDependencyReseed 2026-08-04-06:35:
      A new dependency invalidates every pre-execution approval artifact even
      when merged intake/hold lanes make this a same-column transition. Leaving
      the old fingerprint would let an unchanged prompt bypass manual approval.
      */
      /*
      FNXC:SpecLockDependencyInvalidation 2026-08-09-18:45:
      Dependencies are part of the frozen contract. Adding was previously the only mutation that
      cleared admission, leaving a removed or replaced prerequisite able to run under approval for
      a different plan. Every material dependency edit retires approval evidence, while only the
      existing new-dependency path changes lifecycle placement to request a re-plan.
      */
      if (dependenciesChanged) {
        task.approvedPlanFingerprint = undefined;
        task.awaitingApprovalReason = undefined;
        task.workflowStepResults = supersedePlanReviewResults(
          task.workflowStepResults,
          task.updatedAt,
        );
      }
      if (shouldRespecify) {
        task.status = "needs-replan";
      }
      if (shouldRespecify && replanColumn !== undefined) {
        task.column = replanColumn;
        movedToTriage = true;
        /*
        FNXC:PlanningDependencyReseed 2026-08-04-00:30:
        Dependency mutation shares updateTask's re-specification invariant. A
        real new dependency must leave a durable `needs-replan` claim, never a
        clean status that can strand a persisted plan between planning and the
        pre-release graph gate.
        */
        task.status = "needs-replan";
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-31-02:05 (PR #2720 review — greptile):
        `columnMovedAt` IS THE MOVE TIMESTAMP, so it may only move when the column does. On the default
        lineage post-U11 hold and intake are the SAME column, so this branch runs without the card going
        anywhere — and refreshing the stamp there restarts time-in-column and every staleness calculation
        that reads it, on a card that has not moved. A dependency edit would quietly look like a fresh
        arrival to the stall sweeps.

        The move EVENT below already guards on exactly this condition; the timestamp did not, so the two
        disagreed about whether a move had happened. Same condition, one answer.
        */
        if (replanColumn !== respecifyFromColumn) {
          task.columnMovedAt = task.updatedAt;
        }
        task.log.push({
          timestamp: task.updatedAt,
          action: replanColumn === respecifyFromColumn
            ? "Re-specification requested — new dependency added"
            : `Moved to ${replanColumn} for re-specification — new dependency added`,
          ...(runContext ? { runContext } : {}),
        });
      }
      task.log.push({
        timestamp: task.updatedAt,
        action,
        ...(runContext ? { runContext } : {}),
      });

      const auditEvent: RunAuditEventInput = {
        taskId: id,
        agentId: runContext?.agentId ?? "manual",
        runId: runContext?.runId ?? "manual",
        domain: "database",
        mutationType: "task:dependencies:update",
        target: id,
        metadata: {
          mutation,
          previousDependencies,
          dependencies: nextDependencies,
          blockedBy: task.blockedBy ?? null,
        },
      };
      await store.atomicWriteTaskJsonWithAudit(dir, task, auditEvent,
        dependenciesChanged
          ? {expectedCurrentDependencies: normalizedCurrent}
          : undefined,
      );
      // FNXC:BoardConsistency 2026-06-21-08:31: updateTaskDependencies' todo→triage re-spec move can also carry title/blocker changes, and leaving taskCache on the pre-move row made watch/SSE/board consumers surface one task ID in two columns (FN-6851/FN-6812). Sync the cache after the authoritative write like sibling mutation paths.
      if (store.isWatching) store.taskCache.set(id, { ...task });
      /*
      FNXC:WorkflowLifecycleColumns 2026-08-02-03:10 (fleet — THE EVENT IS A DESTINATION TOO):
      The emitted `from`/`to` were hardcoded `todo`/`triage`. That is not cosmetic: `task:moved` is what the
      GitHub tracking poster, the auto-merge handoff and the executor's listeners react to, so this handed
      every listener a column pair that need not exist. On TODAY'S DEFAULT BOARD `triage` is gone — U11
      merged Todo into Planning keeping the id `todo` — so this event has been announcing a deleted column
      to every subscriber.

      The real endpoints are emitted now. When intake and hold are the SAME column (which is the default
      lineage post-U11) there is no move to announce, so no event is emitted — announcing a move to the
      column the card is already in is what re-runs reset-on-entry effects downstream.
      */
      if (movedToTriage && respecifyFromColumn !== task.column) {
        const lanes = toTaskMoveLanes(await resolveWorkflowIrForTask(store, task.id).catch(() => undefined));
        /* FNXC:WorkflowEvents 2026-08-22-00:13: an unresolved payload is unknown; retain a warm real cache answer until its TTL expires. */
      if (lanes) store.laneCache.set(task.id, lanes);
        store.emit("task:moved", {
          task,
          from: respecifyFromColumn as Column,
          to: task.column as Column,
          source: "engine",
          lanes,
        });
      }
      store.emitTaskLifecycleEventSafely("task:updated", [task]);
      return task;
    });
    /*
    FNXC:SpecLockDependencyInvalidation 2026-08-09-18:45:
    Publish the inactive-lock report before the planning lifecycle lock is released, but after the
    task lock is released: `getTask()` intentionally acquires the latter and is non-reentrant.
    A report outage remains retryable telemetry and cannot undo a valid dependency mutation.
    */
    if (store.isBackendMode()) {
      await store.reconcileSpecDriftWhilePlanningLocked(updated).catch((error: unknown) => {
        storeLog.warn(`[spec-lock] deferred dependency drift reconciliation for ${updated.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return updated;
  }
