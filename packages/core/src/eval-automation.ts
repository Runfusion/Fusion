import type { AutomationStore } from "./automation-store.js";
import type { ScheduledTask, ScheduledTaskCreateInput } from "./automation.js";
import type { EvalRun, EvalTaskResultCreateInput } from "./eval-types.js";
import { EvalLifecycleError } from "./eval-store.js";
import type { ProjectSettings, Task } from "./types.js";

export const TASK_EVALUATION_SCHEDULE_NAME = "Scheduled Task Evaluation";
export const DEFAULT_TASK_EVALUATION_SCHEDULE = "0 5 * * *";
export const TASK_EVALUATION_SCHEDULE_COMMAND = "fn eval --scheduled-batch";

export interface ResolvedTaskEvaluationSettings {
  taskEvaluationEnabled: boolean;
  taskEvaluationSchedule: string;
  taskEvaluationProvider?: string;
  taskEvaluationModelId?: string;
  taskEvaluationFollowUpPolicy: "off" | "suggest" | "create";
  taskEvaluationRetention?: number;
}

export function resolveTaskEvaluationSettings(
  settings: Partial<ProjectSettings>,
): ResolvedTaskEvaluationSettings {
  return {
    taskEvaluationEnabled: settings.taskEvaluationEnabled ?? false,
    taskEvaluationSchedule: settings.taskEvaluationSchedule ?? DEFAULT_TASK_EVALUATION_SCHEDULE,
    taskEvaluationProvider: settings.taskEvaluationProvider,
    taskEvaluationModelId: settings.taskEvaluationModelId,
    taskEvaluationFollowUpPolicy: settings.taskEvaluationFollowUpPolicy ?? "off",
    taskEvaluationRetention: settings.taskEvaluationRetention,
  };
}

export function createScheduledEvalBatchAutomation(
  settings: Partial<ProjectSettings>,
): ScheduledTaskCreateInput {
  const resolved = resolveTaskEvaluationSettings(settings);
  return {
    name: TASK_EVALUATION_SCHEDULE_NAME,
    description: "Evaluates tasks completed since the previous scheduled evaluation batch",
    scheduleType: "custom",
    cronExpression: resolved.taskEvaluationSchedule,
    command: TASK_EVALUATION_SCHEDULE_COMMAND,
    enabled: true,
    scope: "project",
  };
}

export async function syncScheduledEvalBatchAutomation(
  automationStore: AutomationStore,
  settings: Partial<ProjectSettings>,
): Promise<ScheduledTask | undefined> {
  const { AutomationStore } = await import("./automation-store.js");
  const resolved = resolveTaskEvaluationSettings(settings);
  const schedules = await automationStore.listSchedules();
  const existing = schedules.find((s) => s.name === TASK_EVALUATION_SCHEDULE_NAME);

  if (!resolved.taskEvaluationEnabled) {
    if (existing) await automationStore.deleteSchedule(existing.id);
    return undefined;
  }

  if (!AutomationStore.isValidCron(resolved.taskEvaluationSchedule)) {
    throw new Error(`Invalid task evaluation schedule: ${resolved.taskEvaluationSchedule}`);
  }

  const input = createScheduledEvalBatchAutomation(settings);
  if (existing) {
    return automationStore.updateSchedule(existing.id, {
      scheduleType: "custom",
      cronExpression: input.cronExpression,
      command: input.command,
      enabled: true,
      scope: "project",
    });
  }

  return automationStore.createSchedule(input);
}

export interface EvalBatchWindow {
  windowStartExclusive?: string;
  windowEndInclusive: string;
}

export interface CompletedTaskEvaluationContext {
  run: EvalRun;
  task: Task;
  taskIndex: number;
  totalTasks: number;
  window: EvalBatchWindow;
}

export type CompletedTaskEvaluator = (
  context: CompletedTaskEvaluationContext,
) => Promise<Omit<EvalTaskResultCreateInput, "taskId" | "taskSnapshot">>;

export interface EvalBatchTaskStore {
  listTasks(options?: { column?: string }): Promise<Task[]>;
  getEvalStore(): import("./eval-store.js").EvalStore;
}

export interface RunScheduledEvalBatchParams {
  store: EvalBatchTaskStore;
  projectId: string;
  evaluator: CompletedTaskEvaluator;
  startedAt?: string;
}

export interface ScheduledEvalBatchResult {
  runId: string;
  status: "completed" | "failed";
  windowStartExclusive?: string;
  windowEndInclusive: string;
  selectedTaskIds: string[];
  tasksSelected: number;
}

export async function runScheduledEvalBatch(
  params: RunScheduledEvalBatchParams,
): Promise<ScheduledEvalBatchResult> {
  const startedAt = params.startedAt ?? new Date().toISOString();
  const evalStore = params.store.getEvalStore();
  const priorRuns = evalStore
    .listRuns({ projectId: params.projectId, trigger: "schedule" })
    .filter((run) => run.status === "completed")
    .sort((a, b) => {
      const aWindowEnd = (a.metadata?.windowEndInclusive as string | undefined) ?? a.window.until ?? "";
      const bWindowEnd = (b.metadata?.windowEndInclusive as string | undefined) ?? b.window.until ?? "";
      if (aWindowEnd !== bWindowEnd) return aWindowEnd.localeCompare(bWindowEnd);
      return a.id.localeCompare(b.id);
    });

  const previousScheduledBatch = priorRuns.at(-1);
  const windowStartExclusive =
    (previousScheduledBatch?.metadata?.windowEndInclusive as string | undefined) ??
    previousScheduledBatch?.window.until;
  const windowEndInclusive = startedAt;

  let run: EvalRun;
  try {
    run = evalStore.createRun({
      projectId: params.projectId,
      trigger: "schedule",
      scope: "completed-tasks",
      window: {
        since: windowStartExclusive,
        until: windowEndInclusive,
      },
      metadata: {
        windowStartExclusive,
        windowEndInclusive,
      },
    });
  } catch (error) {
    if (error instanceof EvalLifecycleError && error.code === "active_run_conflict") {
      throw error;
    }
    throw error;
  }

  evalStore.appendRunEvent(run.id, {
    type: "info",
    message: "Scheduled eval batch started",
    status: "pending",
    metadata: { windowStartExclusive, windowEndInclusive },
  });

  evalStore.updateRun(run.id, { status: "running", startedAt });

  try {
    const doneTasks = (await params.store.listTasks({ column: "done" })).filter((task) =>
      task.column === "done"
      && Boolean(task.executionCompletedAt)
      && (!windowStartExclusive || task.executionCompletedAt! > windowStartExclusive)
      && task.executionCompletedAt! <= windowEndInclusive,
    );

    doneTasks.sort((a, b) => {
      const byCompletedAt = (a.executionCompletedAt ?? "").localeCompare(b.executionCompletedAt ?? "");
      if (byCompletedAt !== 0) return byCompletedAt;
      const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
      if (byCreatedAt !== 0) return byCreatedAt;
      return a.id.localeCompare(b.id);
    });

    const selectedTaskIds = doneTasks.map((task) => task.id);
    evalStore.updateRun(run.id, {
      counts: { totalTasks: selectedTaskIds.length, scoredTasks: 0, skippedTasks: 0, erroredTasks: 0 },
      metadata: {
        windowStartExclusive,
        windowEndInclusive,
        selectedTaskIds,
        tasksSelected: selectedTaskIds.length,
      },
    });

    if (doneTasks.length === 0) {
      evalStore.appendRunEvent(run.id, {
        type: "info",
        status: "completed",
        message: "Scheduled eval batch completed with no newly done tasks",
        metadata: { tasksSelected: 0 },
      });
      evalStore.updateRun(run.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        summary: "No newly completed tasks found in evaluation window",
      });
      return {
        runId: run.id,
        status: "completed",
        windowStartExclusive,
        windowEndInclusive,
        selectedTaskIds: [],
        tasksSelected: 0,
      };
    }

    let scoredTasks = 0;
    let skippedTasks = 0;
    let erroredTasks = 0;
    const evaluatedTaskIds: string[] = [];

    for (const [index, task] of doneTasks.entries()) {
      try {
        const result = await params.evaluator({
          run,
          task,
          taskIndex: index,
          totalTasks: doneTasks.length,
          window: { windowStartExclusive, windowEndInclusive },
        });

        evalStore.createTaskResult(run.id, {
          ...result,
          taskId: task.id,
          taskSnapshot: {
            taskId: task.id,
            title: task.title,
            column: task.column,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            executionCompletedAt: task.executionCompletedAt,
            summary: task.summary,
          },
          metadata: {
            ...(result.metadata ?? {}),
            windowEndInclusive,
          },
        });

        evaluatedTaskIds.push(task.id);
        if (result.status === "scored") scoredTasks += 1;
        else if (result.status === "skipped") skippedTasks += 1;
        else erroredTasks += 1;

        evalStore.appendRunEvent(run.id, {
          type: "task_evaluated",
          message: `Evaluated task ${task.id}`,
          taskId: task.id,
          metadata: { status: result.status },
        });
      } catch (error) {
        erroredTasks += 1;
        evalStore.appendRunEvent(run.id, {
          type: "error",
          message: `Failed evaluating task ${task.id}`,
          taskId: task.id,
          metadata: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }

    evalStore.updateRun(run.id, {
      status: "completed",
      evaluatedTaskIds,
      counts: {
        totalTasks: doneTasks.length,
        scoredTasks,
        skippedTasks,
        erroredTasks,
      },
      completedAt: new Date().toISOString(),
      summary: `Scheduled eval batch completed for ${doneTasks.length} task(s)`,
      metadata: {
        windowStartExclusive,
        windowEndInclusive,
        selectedTaskIds,
        tasksSelected: selectedTaskIds.length,
      },
    });

    evalStore.appendRunEvent(run.id, {
      type: "status_changed",
      status: "completed",
      message: `Scheduled eval batch completed (${doneTasks.length} tasks selected)`,
      metadata: { scoredTasks, skippedTasks, erroredTasks },
    });

    return {
      runId: run.id,
      status: "completed",
      windowStartExclusive,
      windowEndInclusive,
      selectedTaskIds,
      tasksSelected: selectedTaskIds.length,
    };
  } catch (error) {
    evalStore.updateRun(run.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      metadata: {
        windowStartExclusive,
        windowEndInclusive,
      },
    });
    evalStore.appendRunEvent(run.id, {
      type: "error",
      status: "failed",
      message: "Scheduled eval batch failed",
      metadata: { error: error instanceof Error ? error.message : String(error) },
    });
    return {
      runId: run.id,
      status: "failed",
      windowStartExclusive,
      windowEndInclusive,
      selectedTaskIds: [],
      tasksSelected: 0,
    };
  }
}
