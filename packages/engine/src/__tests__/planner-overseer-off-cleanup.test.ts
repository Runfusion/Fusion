/*
 * FNXC:PlannerOversight 2026-07-17-00:00:
 * FN-8221 exercises ProjectEngine's real poll seam with a narrow in-memory
 * workflow-settings store. The retained monitor observation must be cleared
 * whenever effective oversight changes to off, regardless of active column or
 * whether the value came from the task override or workflow setting.
 */

import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { ProjectEngine } from "../project-engine.js";
import { PlannerOverseerMonitor } from "../planner-overseer.js";

type PollStore = {
  tasks: Task[];
  workflowValues: Record<string, unknown>;
  listTasks(input: { column: string }): Promise<Task[]>;
  getSettings(): Promise<Record<string, unknown>>;
  getTaskWorkflowSelection(taskId: string): { workflowId: string; stepIds: string[] } | undefined;
  getWorkflowDefinition(id: string): Promise<undefined>;
  getWorkflowSettingsProjectId(): string;
  getWorkflowSettingValues(workflowId: string, projectId: string): Record<string, unknown>;
};

function makeStore(tasks: Task[]): PollStore {
  return {
    tasks,
    workflowValues: {},
    async listTasks({ column }) {
      return this.tasks.filter((task) => task.column === column);
    },
    async getSettings() {
      return {};
    },
    getTaskWorkflowSelection() {
      return { workflowId: "builtin:coding", stepIds: [] };
    },
    async getWorkflowDefinition() {
      return undefined;
    },
    getWorkflowSettingsProjectId() {
      return "fn-8221";
    },
    getWorkflowSettingValues() {
      return this.workflowValues;
    },
  };
}

function makeTask(id: string, column: "in-progress" | "in-review"): Task {
  return {
    id,
    title: id,
    description: "Planner overseer cleanup fixture",
    column,
    status: column,
    priority: "normal",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  } as Task;
}

type PollEngine = {
  pollPlannerOverseer(store: PollStore): Promise<void>;
  getPlannerOverseerRuntimeSnapshot(taskId: string): ReturnType<ProjectEngine["getPlannerOverseerRuntimeSnapshot"]>;
};

function makeEngine(): PollEngine {
  const engine = Object.create(ProjectEngine.prototype) as PollEngine;
  (engine as any).plannerOverseer = new PlannerOverseerMonitor();
  (engine as any).shuttingDown = false;
  (engine as any).plannerRecoveryController = undefined;
  (engine as any).sessionAdvisor = undefined;
  (engine as any).sessionAdvisorLogCursor = new Map();
  (engine as any).plannerObservationEmitDedup = new Map();
  (engine as any).plannerEscalationEmitDedup = new Set();
  return engine;
}

describe("FN-8221 — oversight-off poll cleanup", () => {
  it.each([
    { column: "in-progress" as const, source: "per-task override" as const },
    { column: "in-review" as const, source: "per-task override" as const },
    { column: "in-progress" as const, source: "workflow-effective setting" as const },
    { column: "in-review" as const, source: "workflow-effective setting" as const },
  ])("clears a retained snapshot when $source resolves to off in $column", async ({ column, source }) => {
    const task = makeTask(`${source}-${column}`, column);
    const store = makeStore([task]);
    const engine = makeEngine();

    await engine.pollPlannerOverseer(store);
    expect(engine.getPlannerOverseerRuntimeSnapshot(task.id)).toMatchObject({
      oversightLevel: "autonomous",
      state: "watching",
    });

    if (source === "per-task override") {
      task.plannerOversightLevel = "off";
    } else {
      store.workflowValues.plannerOversightLevel = "off";
    }

    await engine.pollPlannerOverseer(store);
    expect(engine.getPlannerOverseerRuntimeSnapshot(task.id)).toBeNull();
  });

  it("retains a non-idle snapshot while oversight remains active", async () => {
    const task = makeTask("active-oversight", "in-progress");
    const engine = makeEngine();

    await engine.pollPlannerOverseer(makeStore([task]));
    await engine.pollPlannerOverseer(makeStore([task]));

    expect(engine.getPlannerOverseerRuntimeSnapshot(task.id)).toMatchObject({
      oversightLevel: "autonomous",
      state: "watching",
    });
  });
});
