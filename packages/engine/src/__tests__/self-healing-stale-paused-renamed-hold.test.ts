/*
FNXC:WorkflowLifecycleColumns 2026-07-28-03:45 (PR #2470 review, P1):

`getStalePausedTodoSignal` gained a `holdColumn` parameter in B1, but EVERY
production caller omitted it — so the guard still compared against the literal
"todo" and a paused card in a renamed hold column produced no signal at all. The
operator-visible consequence: the dashboard badge and the self-healing log are
both silent for a stalled card, which is indistinguishable from a healthy board.

This sweep needed TWO fixes, and the second is the one a careless patch misses:

  1. the signal call omitted `holdColumn`;
  2. the QUERY itself was `listTasks({ column: "todo" })` — so the sweep never
     even SAW a card in a renamed hold column. Threading the signal alone would
     have been a dead fix: the guard would be correct and still never run.

The store mock below therefore HONORS the column filter. The pre-existing sweep
test mocks `listTasks` to return its fixture regardless of arguments, which means
a renamed-column test written against that harness would pass while the query
stayed broken — exactly the "dead guard passes tests" failure mode. Do not
"simplify" this mock to ignore the filter.
*/
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";

const WF = "custom:wf";
const THRESHOLD_MS = 24 * 60 * 60_000;

function pausedTask(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    paused: true,
    pausedReason: "manual-hold",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Task;
}

function ir(holdId: string): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: holdId, label: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function createStore(tasks: Task[], workflowIr: WorkflowIr | undefined) {
  const logEntry = vi.fn().mockResolvedValue(undefined);
  const selection = { workflowId: WF, stepIds: [] };
  const store = {
    getSettings: vi.fn().mockResolvedValue({ stalePausedTodoThresholdMs: THRESHOLD_MS }),
    /*
    HONORS the column filter — see the file header. A mock that ignores it makes
    the renamed-hold assertions pass against the unfixed query.
    */
    listTasks: vi.fn(async (opts?: { column?: string }) =>
      opts?.column ? tasks.filter((t) => t.column === opts.column) : tasks,
    ),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    logEntry,
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => (workflowIr ? { ir: workflowIr } : null)),
  } as unknown as TaskStore;
  return { store, logEntry };
}

function manager(store: TaskStore) {
  return new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
}

describe("surfaceStalePausedTodos under a renamed hold column", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Well past the threshold from the fixture's columnMovedAt.
    vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces a stale paused card resting in a RENAMED hold column", async () => {
    const task = pausedTask({ id: "FN-R", column: "drafting" });
    const { store, logEntry } = createStore([task], ir("drafting"));

    const surfaced = await manager(store).surfaceStalePausedTodos();

    expect(surfaced).toBe(1);
    expect(logEntry).toHaveBeenCalledWith(
      "FN-R",
      expect.stringContaining("Stale paused todo surfaced [stale-paused-todo]"),
    );
  });

  it("does not scope its query to the literal todo column", async () => {
    /*
    Pins fix #2 directly. Even with a correct signal, a `column: "todo"` query
    hands the loop an empty list for a renamed workflow — the sweep would report
    0 while looking entirely healthy.
    */
    const task = pausedTask({ id: "FN-R", column: "drafting" });
    const { store } = createStore([task], ir("drafting"));

    await manager(store).surfaceStalePausedTodos();

    const columnArgs = (store.listTasks as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { column?: string } | undefined)?.column,
    );
    expect(columnArgs).not.toContain("todo");
  });

  it("does NOT surface a paused card resting in a non-hold column", async () => {
    /* The negative half — otherwise dropping the column filter would surface
       paused cards from every column, which is a louder bug than the silent one
       it replaces. */
    const task = pausedTask({ id: "FN-W", column: "building" });
    const { store, logEntry } = createStore([task], ir("drafting"));

    const surfaced = await manager(store).surfaceStalePausedTodos();

    expect(surfaced).toBe(0);
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("still surfaces a builtin todo card (regression floor)", async () => {
    const task = pausedTask({ id: "FN-D", column: "todo" });
    const { store, logEntry } = createStore([task], ir("todo"));

    const surfaced = await manager(store).surfaceStalePausedTodos();

    expect(surfaced).toBe(1);
    expect(logEntry).toHaveBeenCalledWith("FN-D", expect.stringContaining("Stale paused todo surfaced"));
  });

  it("falls back to the legacy todo column when the workflow cannot be resolved", async () => {
    const task = pausedTask({ id: "FN-U", column: "todo" });
    const { store } = createStore([task], undefined);

    expect(await manager(store).surfaceStalePausedTodos()).toBe(1);
  });

  it("surfaces the right cards on a board mixing a renamed and a builtin workflow", async () => {
    /* Per-task resolution, not one board-wide vocabulary: each card's hold
       column comes from ITS OWN workflow. */
    const renamed = pausedTask({ id: "FN-R", column: "drafting" });
    const legacy = pausedTask({ id: "FN-D", column: "todo" });
    const irByWorkflow: Record<string, WorkflowIr> = {
      "wf-renamed": ir("drafting"),
      "wf-legacy": ir("todo"),
    };
    const byTask: Record<string, string> = { "FN-R": "wf-renamed", "FN-D": "wf-legacy" };
    const tasks = [renamed, legacy];
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const store = {
      getSettings: vi.fn().mockResolvedValue({ stalePausedTodoThresholdMs: THRESHOLD_MS }),
      listTasks: vi.fn(async (opts?: { column?: string }) =>
        opts?.column ? tasks.filter((t) => t.column === opts.column) : tasks,
      ),
      getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
      logEntry,
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
      getTaskWorkflowSelection: vi.fn((id: string) => ({ workflowId: byTask[id], stepIds: [] })),
      getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => ({ workflowId: byTask[id], stepIds: [] })),
      getWorkflowDefinition: vi.fn(async (id: string) =>
        irByWorkflow[id] ? { ir: irByWorkflow[id] } : null,
      ),
    } as unknown as TaskStore;

    const surfaced = await manager(store).surfaceStalePausedTodos();

    expect(surfaced).toBe(2);
    expect(logEntry.mock.calls.map((c) => c[0]).sort()).toEqual(["FN-D", "FN-R"]);
  });
});
