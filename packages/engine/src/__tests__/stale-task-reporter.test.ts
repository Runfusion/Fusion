import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { StaleTaskReporter } from "../stale-task-reporter.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    description: "test",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    paused: false,
    log: [],
    updatedAt: "2026-05-14T00:00:00.000Z",
    createdAt: "2026-05-14T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(taskSets: { inProgress?: Task[]; inReview?: Task[] } = {}, settings: Record<string, unknown> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue(settings),
    listTasks: vi.fn().mockImplementation(async ({ column }) => {
      if (column === "in-progress") return taskSets.inProgress ?? [];
      if (column === "in-review") return taskSets.inReview ?? [];
      return [];
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

describe("StaleTaskReporter", () => {
  it("no-ops under threshold", async () => {
    const now = Date.parse("2026-05-14T08:00:00.000Z");
    const store = createStore({
      inProgress: [createTask({ columnMovedAt: new Date(now - 60_000).toISOString() })],
    }, { staleInProgressWarningMs: 4 * 60 * 60_000, staleInProgressCriticalMs: 24 * 60 * 60_000 });
    const reporter = new StaleTaskReporter({ store, now: () => now });
    const result = await reporter.report();
    expect(result.surfaced).toBe(0);
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("emits warning once and rate-limits repeat within window", async () => {
    const now = Date.parse("2026-05-14T08:00:00.000Z");
    const task = createTask({ columnMovedAt: new Date(now - 5 * 60 * 60_000).toISOString() });
    const store = createStore({ inProgress: [task] }, { staleInProgressWarningMs: 4 * 60 * 60_000, staleInProgressCriticalMs: 24 * 60 * 60_000 });
    const reporter = new StaleTaskReporter({ store, now: () => now });

    expect((await reporter.report()).surfaced).toBe(1);
    task.log.push({ timestamp: new Date(now).toISOString(), action: "Stale task age threshold crossed [warning]: column=in-progress paused=false ageMs=1 warningThresholdMs=1 criticalThresholdMs=1" });
    expect((await reporter.report()).surfaced).toBe(0);
  });

  it("emits on warning->critical and critical->warning level changes", async () => {
    const now = Date.parse("2026-05-14T12:00:00.000Z");
    const task = createTask({
      columnMovedAt: new Date(now - 30 * 60 * 60_000).toISOString(),
      log: [{ timestamp: new Date(now - 60_000).toISOString(), action: "Stale task age threshold crossed [warning]: x" }],
    });
    const store = createStore({ inProgress: [task] }, { staleInProgressWarningMs: 4 * 60 * 60_000, staleInProgressCriticalMs: 24 * 60 * 60_000 });
    const reporter = new StaleTaskReporter({ store, now: () => now });
    expect((await reporter.report()).surfaced).toBe(1);

    task.columnMovedAt = new Date(now - 6 * 60 * 60_000).toISOString();
    task.log = [{ timestamp: new Date(now - 60_000).toISOString(), action: "Stale task age threshold crossed [critical]: x" }];
    expect((await reporter.report()).surfaced).toBe(1);
  });

  it("skips merge-confirmed and recently-updated tasks", async () => {
    const now = Date.parse("2026-05-14T12:00:00.000Z");
    const store = createStore({
      inProgress: [createTask({ columnMovedAt: new Date(now - 30 * 60 * 60_000).toISOString(), mergeDetails: { mergeConfirmed: true } })],
      inReview: [createTask({ id: "FN-2", column: "in-review", columnMovedAt: new Date(now - 30 * 60 * 60_000).toISOString(), updatedAt: new Date(now).toISOString() })],
    }, { staleInProgressWarningMs: 4 * 60 * 60_000, staleInProgressCriticalMs: 24 * 60 * 60_000, staleInReviewWarningMs: 24 * 60 * 60_000, staleInReviewCriticalMs: 3 * 24 * 60 * 60_000 });
    const reporter = new StaleTaskReporter({ store, now: () => now });
    expect((await reporter.report()).surfaced).toBe(0);
  });

  it("returns zero and skips scans when all thresholds disabled", async () => {
    const store = createStore({}, { staleInProgressWarningMs: 0, staleInProgressCriticalMs: 0, staleInReviewWarningMs: 0, staleInReviewCriticalMs: 0 });
    const reporter = new StaleTaskReporter({ store });
    const result = await reporter.report();
    expect(result.surfaced).toBe(0);
    expect(store.listTasks).not.toHaveBeenCalled();
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-22:20:

THE INVARIANT: the stale-task sweep reads the board's OWN wip and review lanes.

THE QUERY, NOT A COMPARISON — and this file's census count is **ZERO**. It contains no lifecycle
comparison at all, so it has never appeared in the backlog, in any per-file list, or in any "N → 0"
claim. It was nonetheless completely inert on a custom board: `listTasks({ column })` filters in the
store, both reads returned empty, and the reporter surfaced nothing — on exactly the board where work
is most likely to be sitting unnoticed.

Second demonstration of the class after `backlog-pressure-reporter`, and the pattern is deliberately
identical: resolve the roles, iterate the set, dedupe by id. #2800 measured 49 more of these in
`self-healing.ts` alone.

REVERT PROOF, measured: restore `listTasks({ column: "in-progress" })` and the renamed case surfaces
zero stale tasks instead of one.
*/
describe("stale-task reporting resolves the board's own lanes", () => {
  const RENAMED_IR = {
    version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
    columns: [
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    ],
  };

  /*
  Thresholds are `staleInProgressWarningMs` / `staleInProgressCriticalMs` — my first draft invented
  `staleInProgressHours`, so `hasAnyThreshold` was false and `report()` returned early with 0 before
  reaching the query at all. The cases failed on a fixture I guessed rather than read; that is the
  fourth time this sweep, and the rule stands: read the factory and the settings shape first.
  */
  const NOW = Date.parse("2026-05-14T08:00:00.000Z");

  function renamedStore(tasksByColumn: Record<string, Task[]>): TaskStore {
    return {
      getSettings: vi.fn().mockResolvedValue({
        staleInProgressWarningMs: 4 * 60 * 60_000,
        staleInProgressCriticalMs: 24 * 60 * 60_000,
        staleInReviewWarningMs: 4 * 60 * 60_000,
        staleInReviewCriticalMs: 24 * 60 * 60_000,
      }),
      listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }]),
      /* The per-task resolver reads the SELECTION, not the definition list — the two halves of this
         fix need different store surfaces, and omitting these made the second half silently fall back
         to the legacy pair while the query half already worked. */
      getTaskWorkflowSelection: () => ({ workflowId: "wf-renamed", stepIds: [] }),
      getTaskWorkflowSelectionAsync: async () => ({ workflowId: "wf-renamed", stepIds: [] }),
      getWorkflowDefinition: async () => ({ ir: RENAMED_IR }),
      listTasks: vi.fn(async ({ column }: { column: string }) => tasksByColumn[column] ?? []),
      logEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
  }

  /* This file's factory is `createTask(overrides)`, not `makeTask(id)` — my first draft invented the
     latter and the cases failed on a missing symbol rather than on behaviour. */
  const staleCard = (id: string, column: string): Task =>
    createTask({
      id,
      column,
      columnMovedAt: new Date(NOW - 5 * 60 * 60_000).toISOString(),
      updatedAt: new Date(NOW - 5 * 60 * 60_000).toISOString(),
    });

  it("surfaces a stale card sitting in a RENAMED wip lane", async () => {
    // Pre-fix: the query asked for "in-progress", got nothing, and the sweep surfaced zero.
    const store = renamedStore({ building: [staleCard("FN-1", "building")] });
    const reporter = new StaleTaskReporter({ store, now: () => NOW });

    const result = await reporter.report();

    expect(result.surfaced).toBeGreaterThan(0);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-18:14 (found by BLINDING — the review half was uncovered):
  This describe already declared `signoff` in its IR and no case ever put a card there, so the
  REVIEW resolver was doing nothing any test could see. Measured with the #3214 procedure against
  this file's 7 cases:

      wipColumns    -> ["in-progress"]    1 failed   covered
      reviewColumns -> ["in-review"]      0 failed   UNCOVERED

  Rule 1 in that doc is exactly this: coverage is PER-RESOLVER, not per-sweep. Both resolvers sit in
  one `Promise.all` and read as a single converted sweep; only one of them was held by anything.

  WHAT IT COSTS: `reviewColumns` decides which rows the staleness read even FETCHES. Against the
  literal, a card parked in a renamed review lane is never queried, so a review that has silently
  stalled for days is never surfaced — the precise condition this reporter exists to report.

  The card must be stale by the IN-REVIEW thresholds, which the harness above already supplies; a
  fixture leaning on the in-progress ones would surface through the wip path and prove nothing.
  */
  it("surfaces a stale card sitting in a RENAMED review lane", async () => {
    const store = renamedStore({ signoff: [staleCard("FN-R", "signoff")] });
    const reporter = new StaleTaskReporter({ store, now: () => NOW });

    const result = await reporter.report();

    expect(result.surfaced).toBeGreaterThan(0);
    /* Path-specific: the surfacing side effect names the lane the card is actually in. */
    expect(store.logEntry).toHaveBeenCalledWith("FN-R", expect.stringContaining("column=signoff"));
  });

  it("keeps surfacing legacy-board cards when no workflow resolves", async () => {
    /*
    My first version of this case asserted that a card in `in-progress` is surfaced on the RENAMED
    board, on the theory that the query unions the legacy ids. The query does — but the per-task
    signal then correctly REFUSES it, because that card's own workflow does not call `in-progress` a
    wip lane. The product was right and my premise was wrong.

    What the union actually buys is that the row is FETCHED at all; whether it is stale is then the
    per-task question. So the honest legacy case is a store with no workflow selection, where both
    halves fall back together — which is the compatibility guarantee that actually matters.
    */
    const store = {
      getSettings: vi.fn().mockResolvedValue({
        staleInProgressWarningMs: 4 * 60 * 60_000,
        staleInProgressCriticalMs: 24 * 60 * 60_000,
      }),
      listWorkflowDefinitions: vi.fn(async () => []),
      listTasks: vi.fn(async ({ column }: { column: string }) =>
        (column === "in-progress" ? [staleCard("FN-2", "in-progress")] : [])),
      logEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
    const reporter = new StaleTaskReporter({ store, now: () => NOW });

    expect((await reporter.report()).surfaced).toBeGreaterThan(0);
  });
});
