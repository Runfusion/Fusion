import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { resetHoldReleaseInstrumentation, runHoldReleaseSweep } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WORKFLOW_ID = "custom:priority-age";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "task",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

const workflowIr: WorkflowIr = {
  version: "v2",
  id: WORKFLOW_ID,
  nodes: [],
  edges: [],
  columns: [
    { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
  ],
} as unknown as WorkflowIr;

function createStore(tasks: Task[]): TaskStore {
  const selection = { workflowId: WORKFLOW_ID, stepIds: [] };
  return {
    getSettings: vi.fn(async () => ({ maxConcurrent: 1 })),
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const task = tasks.find((candidate) => candidate.id === id)!;
      task.column = column;
      return { task, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: workflowIr })),
  } as unknown as TaskStore;
}

/*
FNXC:TaskDispatch 2026-08-09-21:04:
A limit of one with no in-progress occupants makes these fixtures a real
competition for one capacity slot. The assertions cover the production sweep's
committed move and the losing card, rather than testing the core comparator alone.
*/
describe("hold-release priority and age ordering (FN-8913)", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
  });

  it("releases the older same-priority candidate before the newer candidate", async () => {
    const newer = makeTask({ id: "FN-020", createdAt: "2026-01-02T00:00:00.000Z", priority: "normal" });
    const older = makeTask({ id: "FN-010", createdAt: "2026-01-01T00:00:00.000Z", priority: "normal" });
    const result = await runHoldReleaseSweep(createStore([newer, older]), { now: () => 1_000_000 });

    expect(result.released).toEqual(["FN-010"]);
    expect(older.column).toBe("in-progress");
    expect(newer.column).toBe("todo");
    expect(result.held).toContainEqual({ taskId: "FN-020", reason: "downstream-full" });
  });

  it("lets newer urgent work win over older normal work", async () => {
    const olderNormal = makeTask({ id: "FN-010", createdAt: "2026-01-01T00:00:00.000Z", priority: "normal" });
    const newerUrgent = makeTask({ id: "FN-020", createdAt: "2026-01-02T00:00:00.000Z", priority: "urgent" });
    const result = await runHoldReleaseSweep(createStore([olderNormal, newerUrgent]), { now: () => 1_000_000 });

    expect(result.released).toEqual(["FN-020"]);
    expect(newerUrgent.column).toBe("in-progress");
    expect(olderNormal.column).toBe("todo");
    expect(result.held).toContainEqual({ taskId: "FN-010", reason: "downstream-full" });
  });

  it("normalizes invalid priorities before ordering candidates by age", async () => {
    const newerInvalid = makeTask({ id: "FN-020", createdAt: "2026-01-02T00:00:00.000Z", priority: "invalid" as Task["priority"] });
    const olderMissing = makeTask({ id: "FN-010", createdAt: "2026-01-01T00:00:00.000Z", priority: undefined });
    const result = await runHoldReleaseSweep(createStore([newerInvalid, olderMissing]), { now: () => 1_000_000 });

    expect(result.released).toEqual(["FN-010"]);
    expect(olderMissing.column).toBe("in-progress");
    expect(newerInvalid.column).toBe("todo");
  });

  it("uses numeric task id as the deterministic tie-break for identical ages", async () => {
    const laterId = makeTask({ id: "FN-020", priority: "normal" });
    const earlierId = makeTask({ id: "FN-010", priority: "normal" });
    const result = await runHoldReleaseSweep(createStore([laterId, earlierId]), { now: () => 1_000_000 });

    expect(result.released).toEqual(["FN-010"]);
    expect(earlierId.column).toBe("in-progress");
    expect(laterId.column).toBe("todo");
  });
});
