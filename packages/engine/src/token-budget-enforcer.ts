import type { GlobalSettings, ProjectSettings, RunMutationContext, Task, TaskStore } from "@fusion/core";
import { createLogger } from "./logger.js";
import { getActiveNotificationService } from "./notifier.js";

const log = createLogger("token-budget-enforcer");

type BudgetSource = "task-override" | "project-per-size" | "project" | "global-per-size" | "global" | "none";

type TokenBudgetStore = Pick<TaskStore, "getTask" | "getSettingsByScope" | "updateTaskAtomic" | "pauseTask">;

export interface ResolvedTaskTokenBudget {
  soft?: number;
  hard?: number;
  source: BudgetSource;
}

export interface TokenBudgetNotification {
  kind: "soft" | "hard";
  task: Task;
  total: number;
  soft?: number;
  hard?: number;
}

export interface EnforcementContext {
  projectSettings: ProjectSettings;
  globalSettings: GlobalSettings;
  runContext?: RunMutationContext;
  notify: (event: TokenBudgetNotification) => Promise<void> | void;
}

function getPerSizeBudget(task: Task, budget: ProjectSettings["taskTokenBudget"] | GlobalSettings["taskTokenBudget"]) {
  const size = task.size;
  if (!size) return undefined;
  return budget?.perSize?.[size];
}

export function resolveTaskTokenBudget(
  task: Task,
  projectSettings: ProjectSettings,
  globalSettings: GlobalSettings,
): ResolvedTaskTokenBudget {
  if (task.tokenBudgetOverride && (task.tokenBudgetOverride.soft !== undefined || task.tokenBudgetOverride.hard !== undefined)) {
    return { soft: task.tokenBudgetOverride.soft, hard: task.tokenBudgetOverride.hard, source: "task-override" };
  }

  const projectBudget = projectSettings.taskTokenBudget;
  const projectPerSize = getPerSizeBudget(task, projectBudget);
  if (projectPerSize && (projectPerSize.soft !== undefined || projectPerSize.hard !== undefined)) {
    return { soft: projectPerSize.soft ?? projectBudget?.soft, hard: projectPerSize.hard ?? projectBudget?.hard, source: "project-per-size" };
  }
  if (projectBudget && (projectBudget.soft !== undefined || projectBudget.hard !== undefined)) {
    return { soft: projectBudget.soft, hard: projectBudget.hard, source: "project" };
  }

  const globalBudget = globalSettings.taskTokenBudget;
  const globalPerSize = getPerSizeBudget(task, globalBudget);
  if (globalPerSize && (globalPerSize.soft !== undefined || globalPerSize.hard !== undefined)) {
    return { soft: globalPerSize.soft ?? globalBudget?.soft, hard: globalPerSize.hard ?? globalBudget?.hard, source: "global-per-size" };
  }
  if (globalBudget && (globalBudget.soft !== undefined || globalBudget.hard !== undefined)) {
    return { soft: globalBudget.soft, hard: globalBudget.hard, source: "global" };
  }

  return { source: "none" };
}

/**
 * FNXC:TokenBudget 2026-07-16-00:00:
 * Budget limits measure newly processed input/output plus cache writes, not cache reads.
 * Cache reads can dominate a session without representing new model work, so using them
 * would unexpectedly pause existing tasks calibrated for actual work tokens.
 */
export function getTokenBudgetUsage(tokenUsage: Task["tokenUsage"]): number {
  return (tokenUsage?.inputTokens ?? 0) + (tokenUsage?.outputTokens ?? 0) + (tokenUsage?.cacheWriteTokens ?? 0);
}

export async function enforceTaskTokenBudget(
  params: { store: Pick<TokenBudgetStore, "updateTaskAtomic" | "pauseTask">; task: Task } & EnforcementContext,
): Promise<void> {
  const { store, task, projectSettings, globalSettings, runContext, notify } = params;
  const total = getTokenBudgetUsage(task.tokenUsage);
  const { soft, hard } = resolveTaskTokenBudget(task, projectSettings, globalSettings);

  if (soft !== undefined && total >= soft) {
    const now = new Date().toISOString();
    let claimedSoft = false;
    await store.updateTaskAtomic(task.id, (current) => {
      if (current.tokenBudgetSoftAlertedAt) return null;
      claimedSoft = true;
      return { tokenBudgetSoftAlertedAt: now };
    }, runContext);
    if (claimedSoft) {
      log.warn(`${task.id}: soft token budget reached (${total}/${soft})`);
      await notify({ kind: "soft", task, total, soft, hard });
    }
  }

  if (hard !== undefined && total >= hard) {
    const now = new Date().toISOString();
    let claimedHard = false;
    await store.updateTaskAtomic(task.id, (current) => {
      if (current.tokenBudgetHardAlertedAt) return null;
      claimedHard = true;
      return { tokenBudgetHardAlertedAt: now };
    }, runContext);
    if (claimedHard) {
      try {
        await store.pauseTask(task.id, true, runContext, { pausedReason: "token_budget_exceeded" });
      } catch (err) {
        await store.updateTaskAtomic(task.id, (current) =>
          current.tokenBudgetHardAlertedAt === now ? { tokenBudgetHardAlertedAt: null } : null,
        runContext).catch(() => {});
        throw err;
      }
      log.error(`${task.id}: hard token budget reached (${total}/${hard}), task paused`);
      await notify({ kind: "hard", task, total, soft, hard });
    }
  }
}

/**
 * FNXC:TokenBudget 2026-07-16-00:00:
 * FN-8056 found the enforcer was dead code; every persisted task.tokenUsage must enter
 * this best-effort helper so documented soft alerts and hard pauses remain live.
 */
export async function enforceTaskTokenBudgetForPersist(
  store: TokenBudgetStore,
  taskId: string,
  runContext?: RunMutationContext,
): Promise<void> {
  try {
    const [task, settings] = await Promise.all([store.getTask(taskId), store.getSettingsByScope()]);
    await enforceTaskTokenBudget({
      store,
      task,
      projectSettings: settings.project as ProjectSettings,
      globalSettings: settings.global,
      runContext,
      notify: async ({ kind, task: notifiedTask, total, soft, hard }) => {
        const notificationService = getActiveNotificationService();
        if (!notificationService) return;
        await notificationService.dispatch("token-budget", {
          taskId: notifiedTask.id,
          taskTitle: notifiedTask.title,
          event: "token-budget",
          timestamp: new Date().toISOString(),
          metadata: { kind, total, soft, hard },
        });
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`${taskId}: token budget enforcement failed: ${message}`);
  }
}
