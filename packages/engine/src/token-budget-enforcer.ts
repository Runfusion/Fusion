import type { GlobalSettings, ProjectSettings, RunMutationContext, Task } from "@fusion/core";
import { createLogger } from "./logger.js";

const log = createLogger("token-budget-enforcer");

type BudgetSource = "task-override" | "project-per-size" | "project" | "global-per-size" | "global" | "none";

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

export async function enforceTaskTokenBudget(
  params: { store: { updateTask: (id: string, updates: Record<string, unknown>, runContext?: RunMutationContext) => Promise<unknown>; pauseTask: (id: string, paused: boolean, runContext?: RunMutationContext) => Promise<unknown> }; task: Task } & EnforcementContext,
): Promise<void> {
  const { store, task, projectSettings, globalSettings, runContext, notify } = params;
  const total = task.tokenUsage?.totalTokens ?? 0;
  const resolved = resolveTaskTokenBudget(task, projectSettings, globalSettings);
  const { soft, hard } = resolved;

  if (soft !== undefined && total >= soft && !task.tokenBudgetSoftAlertedAt) {
    const now = new Date().toISOString();
    await store.updateTask(task.id, { tokenBudgetSoftAlertedAt: now }, runContext);
    log.warn(`${task.id}: soft token budget reached (${total}/${soft})`);
    await notify({ kind: "soft", task, total, soft, hard });
  }

  if (hard !== undefined && total >= hard && !task.tokenBudgetHardAlertedAt) {
    const now = new Date().toISOString();
    await store.updateTask(task.id, { tokenBudgetHardAlertedAt: now }, runContext);
    await store.pauseTask(task.id, true, runContext);
    await store.updateTask(task.id, { pausedReason: "token_budget_exceeded" }, runContext);
    log.error(`${task.id}: hard token budget reached (${total}/${hard}), task paused`);
    await notify({ kind: "hard", task, total, soft, hard });
  }
}
