import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";

const { recordRunAuditEventMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
}));
/*
FNXC:StalledCardWatchdog 2026-08-23-19:02:
`src/run-audit.ts` was folded into `src/util/run-audit.ts` by the domain-folder move (cb57093d03), so a
mock aimed at the old specifier intercepted nothing and every audit assertion in this file went silent —
the detect count still passed while the emission was never observed. Mock the module self-healing.ts
actually imports.
*/
vi.mock("../util/run-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/run-audit.js")>();
  return {
    ...actual,
    createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock, git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() })),
  };
});

import { SelfHealingManager } from "../self-healing.js";
import { executingTaskLock } from "../agents/active-session-registry.js";

/*
FNXC:StalledCardWatchdog 2026-07-26-19:50 (FN-8596 class):
The backstop for "a card must never sit waiting". Every other sweep recovers a KNOWN strand shape;
this one exists for shapes nobody has enumerated yet — FN-8596 sat in `triage` with a finished spec
and nothing anywhere named it, so it was only caught because a human looked at the board.

It is DETECT-ONLY on purpose, and these tests pin that: a generic mutator racing the specialized
sweeps is the exact bug class this area keeps re-fixing. So the assertions are (a) it names a real
stall, and (b) every "this card is legitimately waiting" shape stays silent — a watchdog that cries
wolf gets ignored, which is the same as not having one.
*/

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-07-26T20:00:00.000Z");

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date(NOW - 4 * HOUR).toISOString(),
    // Idle for an hour by default — well past the 30m floor.
    updatedAt: new Date(NOW - HOUR).toISOString(),
    ...overrides,
  } as Task;
}

function storeFor(tasks: Task[], workItems: Record<string, Array<{ state: string }>> = {}): TaskStore & EventEmitter {
  return Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id)),
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    listWorkflowWorkItemsForTask: vi.fn(async (id: string) => workItems[id] ?? []),
  }) as unknown as TaskStore & EventEmitter;
}

function manager(store: TaskStore, opts: Record<string, unknown> = {}) {
  return new SelfHealingManager(store, { ...opts } as never);
}

describe("stalled-card watchdog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    executingTaskLock._clearForTest();
  });

  it("names a card idle past the floor with no session and no continuation", async () => {
    const store = storeFor([task("FN-STALL", { column: "triage", status: "planning" })]);

    expect(await manager(store).detectStalledCards()).toBe(1);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:stall-watchdog-detected",
      target: "FN-STALL",
      metadata: expect.objectContaining({ taskId: "FN-STALL", column: "triage", status: "planning" }),
    }));
  });

  it("stays silent when a continuation is queued to resume the card", async () => {
    const store = storeFor(
      [task("FN-QUEUED")],
      { "FN-QUEUED": [{ state: "held" }] },
    );
    expect(await manager(store).detectStalledCards()).toBe(0);
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
  });

  it("stays silent for a card that is actively executing", async () => {
    const store = storeFor([task("FN-BUSY", { column: "in-progress" })]);
    const mgr = manager(store, { getExecutingTaskIds: () => new Set(["FN-BUSY"]) });
    expect(await mgr.detectStalledCards()).toBe(0);
  });

  it("stays silent for an operator park — a deliberate wait is not a stall", async () => {
    const store = storeFor([
      task("FN-PAUSED", { paused: true }),
      task("FN-USER-PAUSED", { userPaused: true } as Partial<Task>),
    ]);
    expect(await manager(store).detectStalledCards()).toBe(0);
  });

  it("stays silent for terminal columns and for recently-touched cards", async () => {
    const store = storeFor([
      task("FN-DONE", { column: "done" }),
      task("FN-FRESH", { updatedAt: new Date(NOW - 60_000).toISOString() }),
    ]);
    expect(await manager(store).detectStalledCards()).toBe(0);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-17:45:
  `sweepTerminalColumns` was UNCOVERED on the #3115 map. The case directly above asserts the terminal
  skip using the built-in `done` id, so blinding the resolver leaves it green.

  On a renamed board the skip matched nothing, so FINISHED cards were scanned as live and a card
  parked in a renamed completion lane could be reported stalled. A watchdog that cries about
  completed work is worse than a quiet one: it trains operators to ignore the alert, which is the
  failure mode this sweep's dedup logic exists to avoid.
  */
  it("stays silent for a card resting in a RENAMED terminal lane", async () => {
    const store = storeFor([
      task("FN-SHIPPED", { column: "shipped", status: "planning" }),
    ]);
    (store as unknown as { listWorkflowDefinitions: unknown }).listWorkflowDefinitions = vi.fn(async () => [{
      ir: {
        version: "v2",
        id: "custom:renamed",
        nodes: [],
        edges: [],
        columns: [
          { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
          { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
        ],
      },
    }]);

    expect(await manager(store).detectStalledCards()).toBe(0);
  });

  it("does not re-emit for an unchanged card, but re-alerts once its shape changes", async () => {
    const stalled = task("FN-DEDUP", { column: "triage", status: "planning" });
    const store = storeFor([stalled]);
    const mgr = manager(store);

    expect(await mgr.detectStalledCards()).toBe(1);
    expect(await mgr.detectStalledCards()).toBe(0);   // same shape → quiet

    stalled.column = "todo";                          // shape changed → worth saying again
    expect(await mgr.detectStalledCards()).toBe(1);
  });

  it("assumes a continuation exists when the work-item lookup fails, so it never cries wolf", async () => {
    const store = storeFor([task("FN-UNKNOWN")]);
    (store as unknown as { listWorkflowWorkItemsForTask: unknown }).listWorkflowWorkItemsForTask =
      vi.fn(async () => { throw new Error("db down"); });
    expect(await manager(store).detectStalledCards()).toBe(0);
  });

  it("takes no lifecycle action — detection must never move, pause, or fail a card", async () => {
    const store = storeFor([task("FN-NO-MUTATE", { column: "triage", status: "planning" })]);
    await manager(store).detectStalledCards();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("is inert while the engine is paused", async () => {
    const store = storeFor([task("FN-PAUSED-ENGINE")]);
    (store.getSettings as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue({ globalPause: false, enginePaused: true } as Settings);
    expect(await manager(store).detectStalledCards()).toBe(0);
  });
});
