import { describe, expect, it, vi } from "vitest";
import { TaskStore } from "../store.js";

const now = new Date("2026-07-15T12:00:00.000Z");
const staleHeartbeat = "2026-07-15T11:58:00.000Z";
const startedBeforeHeartbeat = "2026-07-15T11:50:00.000Z";

type TimingTask = {
  id: string;
  executionStartedAt?: string;
};

function createStoreDouble(settings: Record<string, unknown>, tasks: TimingTask[]) {
  const updateTask = vi.fn(async (id: string, patch: { executionStartedAt: string }) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) task.executionStartedAt = patch.executionStartedAt;
  });
  return {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => tasks),
    updateTask,
  };
}

async function reconcile(
  store: ReturnType<typeof createStoreDouble>,
  opts?: { engineLastActiveAtOverride?: string },
) {
  return TaskStore.prototype.reconcileActiveTimingForEngineDowntime.call(store as never, now, opts);
}

describe("TaskStore.reconcileActiveTimingForEngineDowntime", () => {
  it("uses a stale captured override despite a fresh settings heartbeat and shifts exactly once by downtime", async () => {
    const tasks = [{ id: "FN-active", executionStartedAt: startedBeforeHeartbeat }];
    const store = createStoreDouble({ pollIntervalMs: 15_000, engineLastActiveAt: now.toISOString() }, tasks);

    const result = await reconcile(store, { engineLastActiveAtOverride: staleHeartbeat });

    expect(result).toEqual({ shiftedTaskIds: ["FN-active"], downtimeMs: 120_000 });
    expect(tasks[0].executionStartedAt).toBe("2026-07-15T11:52:00.000Z");
    // The subsequent in-progress exit accrues only the pre-pause eight-minute segment.
    expect(now.getTime() - Date.parse(tasks[0].executionStartedAt!)).toBe(8 * 60_000);
    expect(store.updateTask).toHaveBeenCalledTimes(1);
  });

  it("treats missing or invalid supplied overrides as no-action without falling back to settings", async () => {
    for (const engineLastActiveAtOverride of [undefined, "not-a-date"]) {
      const tasks = [{ id: "FN-active", executionStartedAt: startedBeforeHeartbeat }];
      const store = createStoreDouble({ pollIntervalMs: 15_000, engineLastActiveAt: staleHeartbeat }, tasks);

      await expect(reconcile(store, { engineLastActiveAtOverride })).resolves.toEqual({
        shiftedTaskIds: [],
        downtimeMs: 0,
      });
      expect(tasks[0].executionStartedAt).toBe(startedBeforeHeartbeat);
      expect(store.updateTask).not.toHaveBeenCalled();
    }
  });

  it("keeps the no-options startup recovery fallback and ignores recent or absent settings heartbeats", async () => {
    const staleTasks = [{ id: "FN-stale", executionStartedAt: startedBeforeHeartbeat }];
    const staleStore = createStoreDouble({ pollIntervalMs: 15_000, engineLastActiveAt: staleHeartbeat }, staleTasks);
    await expect(reconcile(staleStore)).resolves.toEqual({ shiftedTaskIds: ["FN-stale"], downtimeMs: 120_000 });

    for (const engineLastActiveAt of [now.toISOString(), undefined]) {
      const tasks = [{ id: "FN-active", executionStartedAt: startedBeforeHeartbeat }];
      const store = createStoreDouble({ pollIntervalMs: 15_000, engineLastActiveAt }, tasks);
      await expect(reconcile(store)).resolves.toEqual({ shiftedTaskIds: [], downtimeMs: 0 });
      expect(store.updateTask).not.toHaveBeenCalled();
    }
  });

  it("does not shift a task started after the stale heartbeat or downtime at the threshold", async () => {
    const postHeartbeatTask = [{ id: "FN-after-pause", executionStartedAt: "2026-07-15T11:59:00.000Z" }];
    const staleStore = createStoreDouble({ pollIntervalMs: 15_000, engineLastActiveAt: staleHeartbeat }, postHeartbeatTask);
    await expect(reconcile(staleStore)).resolves.toEqual({ shiftedTaskIds: [], downtimeMs: 120_000 });
    expect(staleStore.updateTask).not.toHaveBeenCalled();

    const thresholdStore = createStoreDouble(
      { pollIntervalMs: 15_000, engineLastActiveAt: "2026-07-15T11:59:00.000Z" },
      [{ id: "FN-at-threshold", executionStartedAt: startedBeforeHeartbeat }],
    );
    await expect(reconcile(thresholdStore)).resolves.toEqual({ shiftedTaskIds: [], downtimeMs: 60_000 });
    expect(thresholdStore.updateTask).not.toHaveBeenCalled();
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-20:15:
THE DOWNTIME SHIFT'S WIP READ, on a RENAMED board.

This sweep excludes stopped-engine wall-clock from a card's active time. It finds the cards to fix by
querying the board's wip lane, a read converted to `resolveProjectColumnsForRoles(this,
["countsTowardWip"])`.

WHY THESE CASES EXIST. Blinding that resolver back to `["in-progress"]` left every test that touches
this sweep green — 4 here plus 424 in the two engine files that exercise it, 428 in total. The double
above cannot see the conversion for two independent reasons, and it takes only one:

  1. `listTasks: vi.fn(async () => tasks)` ignores its `column` argument, so it returns the same rows
     whichever lane is requested. A fake that ignores its own filter cannot see a filter bug — which
     is precisely the bug this resolver exists to fix.
  2. `resolveProjectColumnsForRoles` returns the LEGACY ids and nothing else when the store has no
     `listWorkflowDefinitions` (an intentional degrade in project-lane-vocabulary.ts so an unreadable
     workflow list cannot fail a sweep). Without that method the resolved set and the literal set are
     equal by construction.

The double below fixes both and changes nothing else. The existing cases keep the original double on
purpose: they are about heartbeat and threshold arithmetic, not lanes, and rewriting them would put
unrelated churn in the same commit.

WHAT BREAKS WITHOUT THE CONVERSION. On a board whose wip lane is `building`, the sweep queries
`in-progress`, finds NO tasks, and shifts no anchor. Every card silently absorbs the stopped-engine
wall-clock the sweep exists to exclude — the task's reported active time is simply wrong, with
nothing failing to signal it.
*/

const RENAMED_WIP = "building";

function createLaneAwareStoreDouble(
  settings: Record<string, unknown>,
  tasks: Array<TimingTask & { column: string }>,
  wipColumn: string,
) {
  const updateTask = vi.fn(async (id: string, patch: { executionStartedAt: string }) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) task.executionStartedAt = patch.executionStartedAt;
  });
  const ir = {
    version: "v2",
    id: "custom:renamed-wip",
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: wipColumn, label: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", label: "Complete", traits: [{ trait: "complete" }] },
    ],
  };
  return {
    getSettings: vi.fn(async () => settings),
    /* Honours `column`, unlike the double above. */
    listTasks: vi.fn(async (query?: { column?: string }) =>
      (query?.column ? tasks.filter((task) => task.column === query.column) : tasks)),
    updateTask,
    /* Without this the resolver hands back legacy ids only. */
    listWorkflowDefinitions: vi.fn(async () => [{ ir }]),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
  };
}

describe("TaskStore.reconcileActiveTimingForEngineDowntime resolves the board's own wip lane", () => {
  async function shiftedIdsFor(wipColumn: string): Promise<string[]> {
    const tasks = [{ id: "FN-active", executionStartedAt: startedBeforeHeartbeat, column: wipColumn }];
    const store = createLaneAwareStoreDouble(
      { pollIntervalMs: 15_000, engineLastActiveAt: staleHeartbeat },
      tasks,
      wipColumn,
    );
    const result = await TaskStore.prototype.reconcileActiveTimingForEngineDowntime.call(store as never, now);
    return result.shiftedTaskIds;
  }

  it("default vocabulary: shifts a card resting in the wip lane", async () => {
    expect(await shiftedIdsFor("in-progress")).toEqual(["FN-active"]);
  });

  it("renamed vocabulary: shifts a card resting in the RENAMED wip lane", async () => {
    expect(await shiftedIdsFor(RENAMED_WIP)).toEqual(["FN-active"]);
  });

  it("both vocabularies reach the SAME outcome — no column-id literal survives on this path", async () => {
    expect(await shiftedIdsFor(RENAMED_WIP)).toEqual(await shiftedIdsFor("in-progress"));
  });

  it("does not shift a card outside the wip lane on a renamed board", async () => {
    /*
    The complement of the case above: widening the lane read must not turn the sweep into a
    board-wide rewrite. A held card has no stopped-engine time to exclude.
    */
    const tasks = [{ id: "FN-held", executionStartedAt: startedBeforeHeartbeat, column: "todo" }];
    const store = createLaneAwareStoreDouble(
      { pollIntervalMs: 15_000, engineLastActiveAt: staleHeartbeat },
      tasks,
      RENAMED_WIP,
    );
    const result = await TaskStore.prototype.reconcileActiveTimingForEngineDowntime.call(store as never, now);
    expect(result.shiftedTaskIds).toEqual([]);
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
