import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.js";
import { EvalStore } from "../eval-store.js";
import {
  DEFAULT_TASK_EVALUATION_SCHEDULE,
  createScheduledEvalBatchAutomation,
  resolveTaskEvaluationSettings,
  runScheduledEvalBatch,
  syncScheduledEvalBatchAutomation,
} from "../eval-automation.js";

function task(id: string, column: "done" | "todo" | "archived", completedAt: string, createdAt = "2026-01-01T00:00:00.000Z") {
  return {
    id,
    column,
    createdAt,
    updatedAt: createdAt,
    executionCompletedAt: completedAt,
    title: id,
    summary: id,
  } as any;
}

describe("eval-automation", () => {
  it("resolves task evaluation settings defaults", () => {
    const resolved = resolveTaskEvaluationSettings({});
    expect(resolved.taskEvaluationEnabled).toBe(false);
    expect(resolved.taskEvaluationSchedule).toBe(DEFAULT_TASK_EVALUATION_SCHEDULE);
    expect(resolved.taskEvaluationProvider).toBeUndefined();
    expect(resolved.taskEvaluationModelId).toBeUndefined();
    expect(resolved.taskEvaluationFollowUpPolicy).toBe("off");
    expect(resolved.taskEvaluationRetention).toBeUndefined();
  });

  it("resolves task evaluation provider/model/retention overrides", () => {
    const resolved = resolveTaskEvaluationSettings({
      taskEvaluationEnabled: true,
      taskEvaluationProvider: "anthropic",
      taskEvaluationModelId: "claude-sonnet-4-5",
      taskEvaluationFollowUpPolicy: "create",
      taskEvaluationRetention: 30,
    });

    expect(resolved.taskEvaluationEnabled).toBe(true);
    expect(resolved.taskEvaluationProvider).toBe("anthropic");
    expect(resolved.taskEvaluationModelId).toBe("claude-sonnet-4-5");
    expect(resolved.taskEvaluationFollowUpPolicy).toBe("create");
    expect(resolved.taskEvaluationRetention).toBe(30);
  });

  it("creates scheduled eval automation", () => {
    const input = createScheduledEvalBatchAutomation({ taskEvaluationSchedule: "0 9 * * *" });
    expect(input.name).toBe("Scheduled Task Evaluation");
    expect(input.cronExpression).toBe("0 9 * * *");
    expect(input.scope).toBe("project");
  });

  it("syncs schedule create/delete based on enabled flag", async () => {
    const schedules: any[] = [];
    const automationStore = {
      listSchedules: async () => schedules,
      createSchedule: async (input: any) => ({ ...input, id: "S-1" }),
      deleteSchedule: async () => true,
      updateSchedule: async () => undefined,
    } as any;

    const created = await syncScheduledEvalBatchAutomation(automationStore, { taskEvaluationEnabled: true });
    expect(created?.name).toBe("Scheduled Task Evaluation");

    schedules.push({ id: "S-1", name: "Scheduled Task Evaluation" });
    const deleted = await syncScheduledEvalBatchAutomation(automationStore, { taskEvaluationEnabled: false });
    expect(deleted).toBeUndefined();
  });

  it("selects done tasks on first run and orders deterministically", async () => {
    const db = createDatabase("/tmp/fn-eval-automation-1", { inMemory: true });
    db.init();
    const evalStore = new EvalStore(db);
    const tasks = [
      task("FN-2", "done", "2026-05-01T01:00:00.000Z", "2026-01-02T00:00:00.000Z"),
      task("FN-1", "done", "2026-05-01T01:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      task("FN-3", "done", "2026-05-01T02:00:00.000Z"),
      task("FN-4", "todo", "2026-05-01T03:00:00.000Z"),
      task("FN-5", "archived", "2026-05-01T04:00:00.000Z"),
    ];

    const result = await runScheduledEvalBatch({
      projectId: "proj",
      store: {
        listTasks: async () => tasks,
        getEvalStore: () => evalStore,
      } as any,
      startedAt: "2026-05-01T05:00:00.000Z",
      evaluator: async ({ task }) => ({ status: "scored", categoryScores: [], evidence: [], deterministicSignals: [], followUps: [], summary: task.id }),
    });

    expect(result.status).toBe("completed");
    expect(result.selectedTaskIds).toEqual(["FN-1", "FN-2", "FN-3"]);

    const run = evalStore.getRun(result.runId)!;
    expect(run.counts.totalTasks).toBe(3);
    expect(run.metadata?.windowEndInclusive).toBe("2026-05-01T05:00:00.000Z");
    const results = evalStore.listTaskResults({ runId: run.id });
    expect(results).toHaveLength(3);
    expect(results[0]?.metadata?.windowEndInclusive).toBe("2026-05-01T05:00:00.000Z");
  });

  it("uses previous windowEndInclusive cursor for incremental selection", async () => {
    const db = createDatabase("/tmp/fn-eval-automation-2", { inMemory: true });
    db.init();
    const evalStore = new EvalStore(db);

    evalStore.createRun({
      projectId: "proj",
      trigger: "schedule",
      scope: "completed-tasks",
      window: { until: "2026-05-01T05:00:00.000Z" },
      metadata: { windowEndInclusive: "2026-05-01T05:00:00.000Z" },
    });
    const run = evalStore.listRuns({ projectId: "proj", trigger: "schedule" })[0]!;
    evalStore.updateRun(run.id, { status: "completed", completedAt: "2026-05-01T05:05:00.000Z" });

    const tasks = [
      task("FN-1", "done", "2026-05-01T05:00:00.000Z"),
      task("FN-2", "done", "2026-05-01T05:00:00.001Z"),
      task("FN-3", "done", "2026-05-01T06:00:00.000Z"),
    ];

    const result = await runScheduledEvalBatch({
      projectId: "proj",
      store: { listTasks: async () => tasks, getEvalStore: () => evalStore } as any,
      startedAt: "2026-05-01T06:00:00.000Z",
      evaluator: async () => ({ status: "skipped", categoryScores: [], evidence: [], deterministicSignals: [], followUps: [] }),
    });

    expect(result.windowStartExclusive).toBe("2026-05-01T05:00:00.000Z");
    expect(result.selectedTaskIds).toEqual(["FN-2", "FN-3"]);
  });

  it("completes no-op batch when no tasks are eligible", async () => {
    const db = createDatabase("/tmp/fn-eval-automation-3", { inMemory: true });
    db.init();
    const evalStore = new EvalStore(db);

    const result = await runScheduledEvalBatch({
      projectId: "proj",
      store: { listTasks: async () => [task("FN-1", "todo", "2026-05-01T01:00:00.000Z")], getEvalStore: () => evalStore } as any,
      startedAt: "2026-05-02T01:00:00.000Z",
      evaluator: async () => ({ status: "scored", categoryScores: [], evidence: [], deterministicSignals: [], followUps: [] }),
    });

    expect(result.tasksSelected).toBe(0);
    const run = evalStore.getRun(result.runId)!;
    expect(run.status).toBe("completed");
    expect(run.counts.totalTasks).toBe(0);
  });
});
