import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAuditEventInput, Task, TaskStore } from "@fusion/core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Scheduler } from "../scheduler.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn() };
});

/*
FNXC:PlanReviewStep 2026-07-26-17:10:
The default workflow is plan-in-place: a `todo` card releases only after Plan Review passed, so these
scheduler fixtures model a card that already cleared the gate (the state every real card is in when
the capacity sweep sees it). Holding an unreviewed card is the gate working — that path is owned by
`pre-release-plan-review.test.ts`.
*/
const PASSED_PLAN_REVIEW = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "passed" as const,
  source: "node" as const,
  phase: "pre-merge" as const,
};

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    description: "x",
    column: "todo",
    workflowStepResults: [PASSED_PLAN_REVIEW],
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    nodeId: "node-task",
    checkedOutBy: "agent-owner",
    checkoutNodeId: "node-owner",
    ...overrides,
  } as Task;
}

function createStore(task: Task) {
  const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  const store = {
    listTasks: vi.fn().mockResolvedValue([task]),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 1,
      owningNodeHandoffPolicy: "block",
      unavailableNodePolicy: "block",
    }),
    getTask: vi.fn().mockResolvedValue(task),
    /*
    FNXC:EngineTests 2026-06-27-10:05:
    Scheduler fakes must mirror the production `updateSettings` heartbeat path so node-unreachable audit assertions are not short-circuited by incomplete TaskStore doubles.
    */
    updateSettings: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/tmp/test"),
    getTasksDir: vi.fn().mockReturnValue("/tmp/test/.fusion/tasks"),
    recordRunAuditEvent,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
  return { store, recordRunAuditEvent };
}

describe("Scheduler node-unreachable audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("# Task\nBody");
  });

  it("emits park-action once per blocked task", async () => {
    const { store, recordRunAuditEvent } = createStore(createTask());
    const scheduler = new Scheduler(store, {
      nodeHealthMonitor: { getNodeHealth: vi.fn(() => "offline") } as any,
    });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();
    await scheduler.schedule();

    const events = recordRunAuditEvent.mock.calls.map(([event]) => event as RunAuditEventInput);
    const event = events.find((candidate) => candidate.mutationType === "task:auto-recover-node-unreachable");
    expect(event?.mutationType).toBe("task:auto-recover-node-unreachable");
    expect(event?.metadata).toMatchObject({
      handoffAction: "park",
      decisionPath: "scheduler-handoff-park",
      ownerNodeId: "node-owner",
      ownerNodeHealth: "offline",
    });
  });

  it("emits reassign-local audit metadata", async () => {
    const task = createTask({ id: "FN-2" });
    const { store, recordRunAuditEvent } = createStore(task);
    vi.mocked(store.getSettings).mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 1,
      owningNodeHandoffPolicy: "reassign-local",
      unavailableNodePolicy: "block",
    } as any);
    const scheduler = new Scheduler(store, {
      nodeHealthMonitor: { getNodeHealth: vi.fn((id: string) => (id === "node-owner" ? "offline" : "online")) } as any,
    });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    const events = recordRunAuditEvent.mock.calls.map(([event]) => event as RunAuditEventInput);
    const event = events.find((candidate) => candidate.mutationType === "task:auto-recover-node-unreachable");
    expect(event?.metadata).toMatchObject({
      handoffAction: "reassign-local",
      decisionPath: "scheduler-handoff-reassign-local",
      dispatchNodeBefore: "node-task",
      dispatchNodeAfter: undefined,
    });
  });

  it("emits park-action audit on online foreign owner (FN-4832)", async () => {
    const { store, recordRunAuditEvent } = createStore(createTask({ id: "FN-3" }));
    const scheduler = new Scheduler(store, {
      nodeHealthMonitor: { getNodeHealth: vi.fn(() => "online") } as any,
    });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    const events = recordRunAuditEvent.mock.calls.map(([event]) => event as RunAuditEventInput);
    const event = events.find((candidate) => candidate.mutationType === "task:auto-recover-node-unreachable");
    expect(event?.metadata).toMatchObject({
      handoffAction: "park",
      decisionPath: "scheduler-handoff-park",
      ownerNodeId: "node-owner",
      ownerNodeHealth: "online",
      handoffReason: "owner_recovered",
    });
  });
});
