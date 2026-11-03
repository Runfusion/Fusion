/*
FNXC:ResumePlacement 2026-11-01-23:05 (RUFU-300) — Step 3: the RE-QUEUE authorities.

Step 2 fixed where a RUN starts. This file fixes the other half of the same defect: the authorities that
decide to move or re-plan a card by READING ITS PIN OR ITS HOLD, without reading the gate rows the pin
claims. RUFU-292 carried `workflowIrPinNodeId: "parse"` against `workflowIrPinColumnId: "in-progress"`
while its column said `todo` for six and a half hours — a claim about evidence, believed by three
separate sweeps, none of which asked the card what its own durable evidence said.

Two authorities are covered here, plus the shared predicate they now both consume:
  1. `recoverAdvancedTriageTasks` — re-homes a pinned card out of the planning lane into the pinned
     column. It now stands down when a gate the pinned node sits BEHIND positively refuses the card.
     The positive-only rule is load-bearing: the shape this sweep was BUILT for (a graph that
     self-aborted at a boundary, whose gate row was archived or cleared by another gate's remediation)
     must still be rescued, so a missing row is never a refusal.
  2. `reconcilePrincipalHeldPlanningContinuations` (FN-8923) — writes `needs-replan` to re-queue
     planning. For a card whose evidence already authorises work past the planning lane that write
     discards an APPROVED plan, so it now stands down and says why: an unresolvable principal-routing
     hold is a routing defect, not evidence the plan is wrong.

Everything is in-memory: no real AI, no real worktree, no real network, no timers.
*/
import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

const { resolveWorkflowIrForTaskMock, recordRunAuditEventMock } = vi.hoisted(() => ({
  resolveWorkflowIrForTaskMock: vi.fn(),
  recordRunAuditEventMock: vi.fn(async () => undefined),
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveWorkflowIrForTask: resolveWorkflowIrForTaskMock,
}));
vi.mock("../util/run-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/run-audit.js")>()),
  createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock })),
}));

import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { SelfHealingManager } from "../self-healing.js";
import { pinContradictedByGateEvidence } from "../workflows/resume-placement.js";
import { codingIr, rufu292Task } from "./fixtures/resume-placement-harness.js";

const stale = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A gate row that says "this gate did not authorise the run", latest-first. */
function refusedRow(stepId: string, status: "failed" | "revise" | "pending") {
  return { workflowStepId: stepId, status, completedAt: stale(60_000) } as never;
}

/** A gate row that says "this gate authorised the run". */
function releasedRow(stepId: string) {
  return { workflowStepId: stepId, status: "passed", verdict: "APPROVE_WITH_NOTES", completedAt: stale(120_000) } as never;
}

describe("pinContradictedByGateEvidence — the shared predicate the re-queue authorities consume", () => {
  it("leaves an authorised pin unchallenged (a released gate behind the pinned node is the pin's own proof)", () => {
    const task = rufu292Task({ workflowStepResults: [releasedRow("plan-review")] } as never);
    expect(pinContradictedByGateEvidence({ ir: codingIr, task, pinnedNodeId: "parse" })).toBeUndefined();
  });

  it("names a gate BEFORE the pinned node whose latest row refuses the card", () => {
    const task = rufu292Task({ workflowStepResults: [refusedRow("plan-review", "failed")] } as never);
    expect(pinContradictedByGateEvidence({ ir: codingIr, task, pinnedNodeId: "parse" })).toBe("plan-review");
  });

  it("treats a superseded approval as a contradiction, not as an approval", () => {
    const superseded = {
      workflowStepId: "plan-review",
      status: "passed",
      verdict: "APPROVE",
      completedAt: stale(120_000),
      supersededAt: stale(30_000),
    } as never;
    const task = rufu292Task({ workflowStepResults: [superseded] } as never);
    expect(pinContradictedByGateEvidence({ ir: codingIr, task, pinnedNodeId: "parse" })).toBe("plan-review");
  });

  /*
   * The load-bearing negative leg. `recoverAdvancedTriageTasks` rescues cards whose gate row is GONE
   * (archived, or cleared as collateral by another gate's remediation — FN-6797's shape). Refusing on
   * absence would strand exactly the cards that sweep exists to rescue, which is a worse failure than
   * the one being prevented, so absence must stay unchallenged.
   */
  it("is unchallenged by ABSENCE — no rows is not evidence against the pin", () => {
    expect(pinContradictedByGateEvidence({ ir: codingIr, task: rufu292Task(), pinnedNodeId: "parse" })).toBeUndefined();
  });

  it("ignores a gate AFTER the pinned node — the pin never claims to have reached it", () => {
    const task = rufu292Task({ workflowStepResults: [refusedRow("code-review", "failed")] } as never);
    expect(pinContradictedByGateEvidence({ ir: codingIr, task, pinnedNodeId: "parse" })).toBeUndefined();
  });

  it("is unjudgable, so unchallenged, for a pin the current IR cannot place", () => {
    const task = rufu292Task({ workflowStepResults: [refusedRow("plan-review", "failed")] } as never);
    // A node the IR no longer declares (a removed column, a renamed workflow) carries no position.
    expect(pinContradictedByGateEvidence({ ir: codingIr, task, pinnedNodeId: "node-deleted-in-revision" })).toBeUndefined();
    // A v1 IR has no forward order to reason over.
    expect(pinContradictedByGateEvidence({
      ir: { version: "v1", nodes: [], edges: [] } as never,
      task,
      pinnedNodeId: "parse",
    })).toBeUndefined();
  });

  it("judges the LATEST duplicate row, not the first (a retried gate is not stuck on its old failure)", () => {
    const task = rufu292Task({
      workflowStepResults: [
        { workflowStepId: "plan-review", status: "failed", completedAt: stale(300_000) } as never,
        releasedRow("plan-review"),
      ] } as never);
    expect(pinContradictedByGateEvidence({ ir: codingIr, task, pinnedNodeId: "parse" })).toBeUndefined();
  });
});

/* ── Authority 1: the advanced-triage pin re-home ─────────────────────────────── */

function triageStore(task: Task) {
  const rows = new Map([[task.id, task]]);
  const logged: string[] = [];
  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false }) as Settings),
    listTasks: vi.fn(async () => [...rows.values()]),
    getTask: vi.fn(async (id: string) => rows.get(id)),
    moveTaskIf: vi.fn(async (
      id: string,
      column: Task["column"],
      predicate: (live: Task) => boolean | Promise<boolean>,
    ) => {
      const current = rows.get(id)!;
      if (!await predicate(current)) return { task: current, moved: false };
      const moved = { ...current, column } as Task;
      rows.set(id, moved);
      return { task: moved, moved: true };
    }),
    logEntry: vi.fn(async (_id: string, message: string) => { logged.push(message); }),
    getRootDir: vi.fn(() => "requeue-project"),
  } as unknown as TaskStore;
  return { store, logged, rows };
}

function strandedPinTask(over: Partial<Task> = {}): Task {
  return {
    ...rufu292Task(),
    id: "RUFU-300-STRANDED",
    column: "todo",
    status: null,
    paused: false,
    error: undefined,
    worktree: "/worktrees/rufu-300-stranded",
    workflowIrPinNodeId: "parse",
    workflowIrPinColumnId: "in-progress",
    ...over,
  } as unknown as Task;
}

describe("advanced-triage pin re-home asks the pin's own gate question before it moves", () => {
  it("still rescues the shape the sweep was built for — a pinned card behind an authorised gate", async () => {
    activeSessionRegistry.clear();
    const task = strandedPinTask({
      workflowStepResults: [releasedRow("plan-review")] as never,
    });
    const { store, rows } = triageStore(task);
    resolveWorkflowIrForTaskMock.mockResolvedValue(codingIr);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", getExecutingTaskIds: () => new Set<string>() });

    expect(await manager.recoverAdvancedTriageTasks()).toBe(1);
    expect(rows.get(task.id)!.column).toBe("in-progress");
  });

  it("stands down when the pinned position is contradicted, and leaves the card where its evidence says it is", async () => {
    activeSessionRegistry.clear();
    const task = strandedPinTask({
      // The gate the pin sits behind RAN and did not authorise. The pin is a claim the card no longer holds.
      workflowStepResults: [refusedRow("plan-review", "failed")] as never,
    });
    const { store, logged, rows } = triageStore(task);
    resolveWorkflowIrForTaskMock.mockResolvedValue(codingIr);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", getExecutingTaskIds: () => new Set<string>() });

    expect(await manager.recoverAdvancedTriageTasks()).toBe(0);
    expect(rows.get(task.id)!.column).toBe("todo");
    expect(store.moveTaskIf).not.toHaveBeenCalled();
    expect(logged.filter((line) => line.includes("advanced-triage recovery stood down"))).toHaveLength(1);
    expect(logged[0]).toContain("plan-review");

    // Bounded: a sustained disagreement announces once, it does not re-print every sweep.
    await manager.recoverAdvancedTriageTasks();
    await manager.recoverAdvancedTriageTasks();
    expect(logged.filter((line) => line.includes("advanced-triage recovery stood down"))).toHaveLength(1);
  });
});

/* ── Authority 2: FN-8923's planning re-queue ────────────────────────────────── */

const HOLD_REASON = "workflow-principal-role-pool-exhausted:triage";

function heldPlanItem(taskId: string): WorkflowWorkItem {
  return {
    id: "wi-plan", runId: `triage-${taskId}-1`, taskId, nodeId: "plan", kind: "task",
    state: "held", blockedReason: HOLD_REASON, workflowRole: "triage",
    createdAt: stale(600_000), updatedAt: stale(600_000),
  } as WorkflowWorkItem;
}

function planningStore(task: Task) {
  const logged: string[] = [];
  const patches: Array<Partial<Task>> = [];
  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, autoMerge: true }) as Settings),
    listTasks: vi.fn(async () => [task]),
    getTask: vi.fn(async (id: string) => (id === task.id ? task : undefined)),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      patches.push(patch);
      Object.assign(task, patch);
    }),
    listWorkflowWorkItemsForTask: vi.fn(async () => [heldPlanItem(task.id)]),
    logEntry: vi.fn(async (_id: string, message: string) => { logged.push(message); }),
    getRootDir: vi.fn(() => "principal-held-project"),
    getTasksDir: vi.fn(() => ""),
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
  } as unknown as TaskStore;
  return { store, logged, patches };
}

function principalHeldTask(over: Partial<Task> = {}): Task {
  return {
    ...rufu292Task(),
    id: "RUFU-300-PRINCIPAL",
    column: "todo",
    // The candidacy predicate is "no claimant": triage re-admits a planning-lane card only once nothing
    // owns its status, so a status the sweep can read as a live claim (planning / needs-replan) is not
    // this shape — see `isPrincipalHeldPlanningStatusOwned`.
    status: null,
    paused: false,
    userPaused: false,
    steps: [],
    currentStep: 0,
    workflowStepResults: [],
    createdAt: stale(900_000),
    updatedAt: stale(900_000),
    columnMovedAt: stale(900_000),
    ...over,
  } as unknown as Task;
}

describe("a principal-routing planning hold cannot discard an authorised plan", () => {
  it("re-queues planning when nothing is authorised yet (FN-8923's own shape is preserved)", async () => {
    const task = principalHeldTask();
    const { store, patches } = planningStore(task);
    resolveWorkflowIrForTaskMock.mockResolvedValue(codingIr);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcilePrincipalHeldPlanningContinuations()).toBe(1);
    expect(patches).toContainEqual({ status: "needs-replan" });
  });

  it("stands down, with a named no-action reason, when the card's evidence already reaches past the planning lane", async () => {
    const task = principalHeldTask({
      // An approved plan whose successor sits in the execution lane: `needs-replan` here would replan
      // a plan a reviewer already signed, and the re-plan would supersede the approval that made it.
      workflowStepResults: [releasedRow("plan-review")] as never,
    });
    const { store, patches, logged } = planningStore(task);
    resolveWorkflowIrForTaskMock.mockResolvedValue(codingIr);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcilePrincipalHeldPlanningContinuations()).toBe(0);
    expect(patches).toEqual([]);
    expect(logged).toEqual([]);
    const noAction = recordRunAuditEventMock.mock.calls
      .map((call) => call[0] as { type?: string; metadata?: Record<string, unknown> })
      .filter((row) => row.type === "task:reconcile-principal-held-planning-no-action");
    expect(noAction.some((row) => row.metadata?.reason === "released-gate-downstream")).toBe(true);
  });
});
