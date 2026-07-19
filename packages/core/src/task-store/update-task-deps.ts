/**
 * update-task-deps operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog, type TaskDependencyMutation} from "../store.js";
import {buildRefinementSeedPrompt} from "../mesh-task-replication.js";
import {SelfDefeatingDependencyError, detectSelfDefeatingDependency} from "./errors.js";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {existsSync} from "node:fs";
import type {Task, Column, RunMutationContext, RunAuditEventInput} from "../types.js";
import "../builtin-traits.js";
import {normalizeTaskPriority} from "../task-priority.js";
import {extractTaskIdTokens, normalizeTitleForTaskId} from "../task-title-id-drift.js";
import {generateTaskLineageId} from "../task-lineage.js";
import {sanitizeFileScopeInPromptContent} from "../task-store/file-scope.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";

export async function refineTaskImpl(store: TaskStore, id: string, feedback: string): Promise<Task> {
    const sourceTask = await store.getTask(id);

    if (sourceTask.column !== "done" && sourceTask.column !== "in-review") {
      throw new Error(
        `Cannot refine ${id}: task is in '${sourceTask.column}', must be in 'done' or 'in-review'`,
      );
    }

    if (!feedback?.trim()) {
      throw new Error("Feedback is required and cannot be empty");
    }

    const now = new Date().toISOString();
    let sourceLabel: string;
    if (sourceTask.title?.trim()) {
      sourceLabel = sourceTask.title.trim();
    } else {
      const firstLine = sourceTask.description
        .split("\n")
        .map((line: string) => line.trim())
        .find((line: string) => line.length > 0);
      sourceLabel = firstLine ? firstLine.replace(/\s+/g, " ") : sourceTask.id;
    }

    /*
     * FNXC:WorkflowOptionalSteps 2026-07-16-00:00:
     * FN-8188 requires refinements to inherit create-time default-workflow seeding so
     * default-on optional groups, including plan-review and code-review, gate them
     * exactly as they gate newly created tasks.
     */
    let pendingWorkflowSelection: { workflowId: string; stepIds: string[] } | undefined;
    try {
      const inherited = await store.materializeDefaultWorkflowSteps();
      if (inherited) {
        pendingWorkflowSelection = inherited;
      }
    } catch (err) {
      storeLog.warn("Failed to apply default workflow during refinement task creation", {
        phase: "refineTask:default-workflow",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const newTask = await store.createTaskWithDistributedReservation({ description: feedback.trim() }, {
      createTaskWithId: async (newId) => {
        // FN-5077: keep deterministic "Refinement" fallback when normalized refinement label is unusable (null).
        const normalizedTitle = normalizeTitleForTaskId(`Refinement: ${sourceLabel}`, newId);
        if (normalizedTitle.changed) {
          const removed = extractTaskIdTokens(`Refinement: ${sourceLabel}`).filter((token) => token !== newId.toUpperCase());
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
          column: "triage",
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
        await writeFile(join(newDir, "PROMPT.md"), sanitizedPrompt.sanitized);

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
    return store.withTaskLock(id, async () => {
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
        if (store.backendMode) {
          try {
            await store.getTask(dependencyId);
          } catch {
            throw new Error(`Dependency task ${dependencyId} not found`);
          }
          return;
        }
        if (!store.readTaskFromDb(dependencyId)) {
          throw new Error(`Dependency task ${dependencyId} not found`);
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
      const hasNewDependencies = nextDependencies.some((dependencyId) => !previousDependencySet.has(dependencyId));

      task.dependencies = nextDependencies;
      /*
       * FNXC:SqliteFinalRemoval 2026-06-26:
       * In backend mode, readTaskFromDb is unavailable. Use async getTask instead
       * to resolve unresolved dependency and current blocker columns.
       */
      const readDepTask = async (depId: string): Promise<Task | null> => {
        if (store.backendMode) {
          try { return await store.getTask(depId); } catch { return null; }
        }
        return store.readTaskFromDb(depId) ?? null;
      };

      const allDepTasks = await Promise.all(nextDependencies.map(readDepTask));
      const unresolvedDependencyIndex = allDepTasks.findIndex(
        (dep) => dep?.column !== "done" && dep?.column !== "archived",
      );
      const unresolvedDependency = unresolvedDependencyIndex >= 0 ? nextDependencies[unresolvedDependencyIndex] : undefined;

      if (unresolvedDependency) {
        const currentBlocker = task.blockedBy ? await readDepTask(task.blockedBy) : null;
        const currentBlockerResolved = currentBlocker?.column === "done" || currentBlocker?.column === "archived";
        if (!task.blockedBy || !nextDependencies.includes(task.blockedBy) || !currentBlocker || currentBlockerResolved) {
          task.blockedBy = unresolvedDependency;
        }
      } else {
        task.blockedBy = undefined;
      }
      task.updatedAt = new Date().toISOString();
      task.log ??= [];
      let movedToTriage = false;
      if (hasNewDependencies && task.column === "todo") {
        task.column = "triage";
        movedToTriage = true;
        task.status = undefined;
        task.columnMovedAt = task.updatedAt;
        task.log.push({
          timestamp: task.updatedAt,
          action: "Moved to triage for re-specification — new dependency added",
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
      await store.atomicWriteTaskJsonWithAudit(dir, task, auditEvent);
      // FNXC:BoardConsistency 2026-06-21-08:31: updateTaskDependencies' todo→triage re-spec move can also carry title/blocker changes, and leaving taskCache on the pre-move row made watch/SSE/board consumers surface one task ID in two columns (FN-6851/FN-6812). Sync the cache after the authoritative write like sibling mutation paths.
      if (store.isWatching) store.taskCache.set(id, { ...task });
      if (movedToTriage) {
        store.emit("task:moved", { task, from: "todo" as Column, to: "triage" as Column, source: "engine" });
      }
      store.emitTaskLifecycleEventSafely("task:updated", [task]);
      return task;
    });
  }

