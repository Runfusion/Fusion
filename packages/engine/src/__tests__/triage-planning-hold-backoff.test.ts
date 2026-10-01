/*
FNXC:WorkflowAgentRouting 2026-09-23-09:10:
Regression coverage for the planning-hold hot loop. A held planning attempt parks the card on
`needs-replan`; that status write wakes an immediate re-poll, and discovery re-admitted the card at once.
Observed in production as two cards re-specified every ~3s for days with an empty `triage` role pool,
each pass appending a "Planning held" entry and keeping the engine's main thread saturated.

Asserted through the REAL `discoverReadyPlanningTasks`, the method both the poll and the admission
coordinator's refresh use, so the gate cannot be honored on one surface and missed on the other.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { TriageProcessor } from "../triage.js";
import { clearPrincipalHoldBackoff, recordPrincipalHoldBackoff } from "../executor/execute-workflow-graph.js";

const WF = "builtin:coding";
const TASK_ID = "FN-1";
const HOLD_REASON = "workflow-principal-role-pool-exhausted:triage";

function defaultIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function heldCard(): Task {
  return {
    id: TASK_ID,
    title: "held card",
    description: "d",
    column: "todo",
    status: "needs-replan",
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
  } as Task;
}

function createStore(): TaskStore {
  const ir = defaultIr();
  const selection = { workflowId: WF, stepIds: [] };
  return {
    on: vi.fn(),
    off: vi.fn(),
    getTask: vi.fn(async () => undefined),
    listTasks: vi.fn(async () => []),
    getSettings: vi.fn().mockResolvedValue({}),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
    logEntry: vi.fn(),
  } as unknown as TaskStore;
}

async function discover(): Promise<string[]> {
  const processor = new TriageProcessor(createStore(), "/test/project");
  const found = await (processor as unknown as {
    discoverReadyPlanningTasks: (t: Task[], now: number) => Promise<Task[]>;
  }).discoverReadyPlanningTasks([heldCard()], Date.now());
  return found.map((t) => t.id);
}

/* The ladder's base is zero under VITEST; drive the real writer with the production base instead. */
function recordWithProductionBackoff(): { attempt: number; repeated: boolean } {
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  try {
    return recordPrincipalHoldBackoff(TASK_ID, HOLD_REASON);
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("planning discovery honors the principal-hold cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    clearPrincipalHoldBackoff(TASK_ID);
  });

  afterEach(() => {
    clearPrincipalHoldBackoff(TASK_ID);
    vi.useRealTimers();
  });

  it("admits a needs-replan card with no recorded hold", async () => {
    expect(await discover()).toEqual([TASK_ID]);
  });

  it("does NOT re-admit a card while its planning hold is cooling down", async () => {
    recordWithProductionBackoff();
    expect(await discover()).toEqual([]);
  });

  it("re-admits the card once the cooldown window elapses", async () => {
    recordWithProductionBackoff();
    vi.advanceTimersByTime(15_001);
    expect(await discover()).toEqual([TASK_ID]);
  });

  it("escalates the window for a repeated hold with the same reason", async () => {
    expect(recordWithProductionBackoff()).toEqual({ attempt: 1, repeated: false });
    expect(recordWithProductionBackoff()).toEqual({ attempt: 2, repeated: true });
    vi.advanceTimersByTime(15_001);
    expect(await discover()).toEqual([]);
    vi.advanceTimersByTime(15_000);
    expect(await discover()).toEqual([TASK_ID]);
  });

  it("re-admits immediately once the hold is cleared by a successful route", async () => {
    recordWithProductionBackoff();
    clearPrincipalHoldBackoff(TASK_ID);
    expect(await discover()).toEqual([TASK_ID]);
  });
});
