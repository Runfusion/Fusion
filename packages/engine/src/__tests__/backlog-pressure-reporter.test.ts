import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { BacklogPressureReporter } from "../backlog-pressure-reporter.js";

/*
FNXC:PgMigrationQuarantine 2026-07-18-04:15:
VAL-REMOVAL-005 reporters await the PostgreSQL-shaped insight-store contract.
Keep mock reads promise-based so cooldown and payload assertions exercise the
same asynchronous collaborator boundary as production.
*/

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    description: "test",
    title: "Test task",
    column: "todo",
    priority: "normal",
    dependencies: [],
    steps: [],
    currentStep: 0,
    paused: false,
    status: undefined,
    blockedBy: "",
    overlapBlockedBy: "",
    log: [],
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/*
FNXC:WorkflowResolvedColumns 2026-07-31-19:20:
A board whose hold lane is `drafting`, wip is `building` and complete is `shipped`. Supplied through
`listWorkflowDefinitions`, which is the ONLY store read `resolveProjectColumnsForRoles` makes — a
project-wide async read that works under PostgreSQL, unlike the sync workflow-SELECTION reader.
*/
const RENAMED_DEPENDENCY_IR = {
  version: "v2",
  id: "custom:deps",
  nodes: [],
  edges: [],
  columns: [
    { id: "drafting", name: "drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "brewing", name: "brewing", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
  ],
};

function createStore(params: {
  settings?: Record<string, unknown>;
  todoSlim?: Task[];
  inProgressSlim?: Task[];
  todoFull?: Task[];
  allTasks?: Task[];
  insightStore?: { upsertInsight: ReturnType<typeof vi.fn>; listInsights: ReturnType<typeof vi.fn> };
  throwInsightStore?: boolean;
  /** Omitted → the helper keeps the legacy ids, which is every pre-existing case in this file. */
  workflowIr?: unknown;
  holdColumn?: string;
  wipColumn?: string;
}): TaskStore {
  const holdColumn = params.holdColumn ?? "todo";
  const wipColumn = params.wipColumn ?? "in-progress";
  const listTasks = vi.fn().mockImplementation(async (options?: { column?: string; slim?: boolean }) => {
    if (options?.column === holdColumn && options?.slim) return params.todoSlim ?? [];
    if (options?.column === wipColumn && options?.slim) return params.inProgressSlim ?? [];
    if (options?.column === holdColumn && !options?.slim) return params.todoFull ?? [];
    if (!options?.column && options?.slim) return params.allTasks ?? [];
    return [];
  });

  return {
    getSettings: vi.fn().mockResolvedValue(params.settings ?? {}),
    listTasks,
    ...(params.workflowIr ? { listWorkflowDefinitions: vi.fn(async () => [{ ir: params.workflowIr }]) } : {}),
    getInsightStore: vi.fn().mockImplementation(() => {
      if (params.throwInsightStore) throw new Error("missing insight store");
      return params.insightStore;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

describe("BacklogPressureReporter", () => {
  const logger = { warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no-ops when disabled", async () => {
    const store = createStore({ settings: { backlogPressureAlertEnabled: false } });
    const reporter = new BacklogPressureReporter({ store, projectId: "/tmp/project", logger });
    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "disabled" });
  });

  it.each([
    { todo: 25, inProgress: 5, expected: "under-threshold" },
    { todo: 4, inProgress: 0, expected: "under-threshold", settings: { backlogPressureMinTodoCount: 5 } },
  ])("no-ops for threshold matrix %#", async ({ todo, inProgress, expected, settings }) => {
    const todoSlim = Array.from({ length: todo }, (_, i) => createTask({ id: `FN-T${i}`, title: `Todo ${i}` }));
    const inProgressSlim = Array.from({ length: inProgress }, (_, i) => createTask({ id: `FN-P${i}`, column: "in-progress" }));
    const store = createStore({ settings, todoSlim, inProgressSlim });
    const reporter = new BacklogPressureReporter({ store, projectId: "/tmp/project", logger });
    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: expected });
  });

  it("no-ops when fewer than 3 runnable candidates exist", async () => {
    const todoSlim = Array.from({ length: 20 }, (_, i) => createTask({ id: `FN-T${i}` }));
    const inProgressSlim = [createTask({ id: "FN-P1", column: "in-progress" })];
    const todoFull = [
      createTask({ id: "FN-1", blockedBy: "FN-0" }),
      createTask({ id: "FN-2", paused: true }),
      createTask({ id: "FN-3", status: "queued" as Task["status"] }),
      createTask({ id: "FN-4" }),
      createTask({ id: "FN-5" }),
    ];
    const allTasks = [...todoFull, createTask({ id: "FN-0", column: "todo" })];
    const store = createStore({ todoSlim, inProgressSlim, todoFull, allTasks, insightStore: { upsertInsight: vi.fn(), listInsights: vi.fn().mockResolvedValue([]) } });
    const reporter = new BacklogPressureReporter({ store, projectId: "/tmp/project", logger });
    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "insufficient-candidates" });
  });

  it("excludes dependency-blocked candidates but keeps missing-dependency refs", async () => {
    const todoSlim = Array.from({ length: 44 }, (_, i) => createTask({ id: `FN-T${i}` }));
    const inProgressSlim = [createTask({ id: "FN-P1", column: "in-progress" }), createTask({ id: "FN-P2", column: "in-progress" }), createTask({ id: "FN-P3", column: "in-progress" })];
    const todoFull = [
      createTask({ id: "FN-A", priority: "urgent", blockedBy: "FN-X" }),
      createTask({ id: "FN-B", priority: "high", overlapBlockedBy: "FN-Y" }),
      createTask({ id: "FN-C", priority: "high", status: "queued" as Task["status"] }),
      createTask({ id: "FN-D", priority: "high", paused: true }),
      createTask({ id: "FN-E", priority: "urgent", dependencies: ["FN-DEP-TODO"] }),
      createTask({ id: "FN-F", priority: "urgent", dependencies: ["FN-DEP-MISSING"] }),
      createTask({ id: "FN-G", priority: "high" }),
      createTask({ id: "FN-H", priority: "normal" }),
    ];
    const allTasks = [
      ...todoFull,
      createTask({ id: "FN-DEP-TODO", column: "todo" }),
      createTask({ id: "FN-DEP-DONE", column: "done" }),
    ];
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockResolvedValue([]) };
    const reporter = new BacklogPressureReporter({
      store: createStore({ todoSlim, inProgressSlim, todoFull, allTasks, insightStore }),
      projectId: "/tmp/project",
      logger,
      now: () => Date.parse("2026-05-18T12:00:00.000Z"),
    });

    const result = await reporter.report();
    expect(result.alerted).toBe(true);
    const content = JSON.parse(insightStore.upsertInsight.mock.calls[0][1].content);
    const ids = content.candidates.map((candidate: { id: string }) => candidate.id);
    expect(ids).toContain("FN-F");
    expect(ids).toContain("FN-G");
    expect(ids).toContain("FN-H");
    expect(ids).not.toContain("FN-A");
    expect(ids).not.toContain("FN-B");
    expect(ids).not.toContain("FN-C");
    expect(ids).not.toContain("FN-D");
    expect(ids).not.toContain("FN-E");
  });

  it("emits payload with counts, ratio, detectedAt, and candidates", async () => {
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const todoSlim = Array.from({ length: 44 }, (_, i) => createTask({ id: `FN-T${i}` }));
    const inProgressSlim = [createTask({ id: "FN-P1", column: "in-progress" }), createTask({ id: "FN-P2", column: "in-progress" }), createTask({ id: "FN-P3", column: "in-progress" })];
    const todoFull = Array.from({ length: 8 }, (_, i) => createTask({ id: `FN-C${i}`, title: `Candidate ${i}`, priority: i === 0 ? "urgent" : "normal" }));
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockResolvedValue([]) };
    const store = createStore({ todoSlim, inProgressSlim, todoFull, allTasks: todoFull, insightStore });
    const reporter = new BacklogPressureReporter({ store, projectId: "/tmp/project", logger, now: () => now });

    const result = await reporter.report();
    expect(result).toEqual({ alerted: true });
    expect(insightStore.upsertInsight).toHaveBeenCalledTimes(1);
    const input = insightStore.upsertInsight.mock.calls[0][1];
    const content = JSON.parse(input.content);
    expect(content.todoCount).toBe(44);
    expect(content.inProgressCount).toBe(3);
    expect(content.ratio).toBe(14.67);
    expect(content.detectedAt).toBe("2026-05-18T12:00:00.000Z");
    expect(content.candidates.length).toBeGreaterThanOrEqual(3);
  });

  it("respects cooldown window", async () => {
    vi.useFakeTimers();
    try {
      const baseNow = Date.parse("2026-05-18T12:00:00.000Z");
      vi.setSystemTime(baseNow);
      const todoSlim = Array.from({ length: 44 }, (_, i) => createTask({ id: `FN-T${i}` }));
      const inProgressSlim = Array.from({ length: 3 }, (_, i) => createTask({ id: `FN-P${i}`, column: "in-progress" }));
      const todoFull = Array.from({ length: 5 }, (_, i) => createTask({ id: `FN-C${i}` }));
      const insightStore = {
        upsertInsight: vi.fn(),
        listInsights: vi.fn().mockResolvedValue([]),
      };
      const store = createStore({ todoSlim, inProgressSlim, todoFull, allTasks: todoFull, insightStore, settings: { backlogPressureAlertCooldownMs: 60_000 } });
      const reporter = new BacklogPressureReporter({ store, projectId: "/tmp/project", logger, now: () => Date.now() });

      await reporter.report();
      expect(insightStore.upsertInsight).toHaveBeenCalledTimes(1);

      insightStore.listInsights.mockResolvedValue([
        { title: "Backlog pressure detected 2026-05-18", updatedAt: new Date(Date.now()).toISOString() },
      ]);
      await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "under-threshold" });
      expect(insightStore.upsertInsight).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(61_000);
      insightStore.listInsights.mockResolvedValue([
        { title: "Backlog pressure detected 2026-05-18", updatedAt: new Date(baseNow).toISOString() },
      ]);
      await reporter.report();
      expect(insightStore.upsertInsight).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to task log entry when insight store is unavailable", async () => {
    const todoSlim = Array.from({ length: 44 }, (_, i) => createTask({ id: `FN-T${i}` }));
    const inProgressSlim = Array.from({ length: 3 }, (_, i) => createTask({ id: `FN-P${i}`, column: "in-progress" }));
    const todoFull = [
      createTask({ id: "FN-1", priority: "urgent" }),
      createTask({ id: "FN-2", priority: "high" }),
      createTask({ id: "FN-3", priority: "normal" }),
    ];
    const store = createStore({ todoSlim, inProgressSlim, todoFull, allTasks: todoFull, throwInsightStore: true });
    const reporter = new BacklogPressureReporter({ store, projectId: "/tmp/project", logger });

    const result = await reporter.report();
    expect(result).toEqual({ alerted: true });
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", expect.stringContaining("[backlog-pressure]"));
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-20:10:

THE INVARIANT: the backlog-pressure ratio counts the board's OWN hold and wip lanes.

THE QUERY, NOT THE COMPARISON — this reporter had no comparison to convert. `listTasks({ column })`
filters in the store, so on a renamed board both reads return EMPTY and the ratio is computed as 0/0:
the alert never fires, on a board that may be under exactly the pressure it exists to report.

That is the class #2800 measured at 49 sites in `self-healing.ts` alone. The census cannot see any of
them: it scores comparisons, and a query filter is not a comparison. This file had a census count of
ZERO and was completely inert on a custom board.

The resolution goes through `resolveProjectColumnsForRoles`, which answers the PROJECT-level question
a read needs — there is no task in hand yet to resolve from — and always unions the legacy id, so a
board mid-rename still counts rows stored under the old one.

REVERT PROOF, measured: restore `listTasks({ column: "todo" })` and the renamed case reports
`under-threshold` from an empty backlog instead of alerting.
*/
describe("backlog pressure resolves the board's own lanes", () => {
  /* `logger` is scoped to the other describe block; restated rather than hoisted. */
  const laneLogger = { warn: vi.fn(), error: vi.fn() };
  const RENAMED_IR = {
    version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    ],
  };

  function renamedStore(counts: { hold: number; wip: number }): TaskStore {
    const make = (id: string, column: string) => ({ id, column, title: id, priority: "normal" }) as unknown as Task;
    const hold = Array.from({ length: counts.hold }, (_, i) => make(`H-${i}`, "backlog"));
    const wip = Array.from({ length: counts.wip }, (_, i) => make(`W-${i}`, "building"));
    return {
      getSettings: vi.fn().mockResolvedValue({ backlogPressureRatioThreshold: 2, backlogPressureMinTodoCount: 3 }),
      listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }]),
      listTasks: vi.fn(async (options?: { column?: string }) => {
        if (options?.column === "backlog") return hold;
        if (options?.column === "building") return wip;
        /* The legacy ids are still queried and correctly return nothing on this board. */
        return [];
      }),
      getInsightStore: vi.fn(() => ({ upsertInsight: vi.fn(), listInsights: vi.fn(async () => []) })),
      logEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
  }

  it("alerts on a RENAMED board that is genuinely under pressure", async () => {
    // Pre-fix: both reads asked for todo/in-progress, got nothing, and the ratio was 0/0.
    const reporter = new BacklogPressureReporter({
      store: renamedStore({ hold: 10, wip: 1 }),
      projectId: "p1",
      logger: laneLogger,
    });

    const result = await reporter.report();

    expect(result.alerted).toBe(true);
  });

  it("still stays quiet when the renamed board is genuinely under threshold", async () => {
    // The alert must remain conditional — firing always would be its own bug.
    const reporter = new BacklogPressureReporter({
      store: renamedStore({ hold: 1, wip: 5 }),
      projectId: "p1",
      logger: laneLogger,
    });

    expect((await reporter.report()).alerted).toBe(false);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-19:20:
  THE THIRD LANE QUESTION. Hold and wip were already resolved in this reporter; "is this card's
  dependency finished?" was still `dependency.column !== "done"`.

  On a renamed board that makes EVERY dependency look unfinished, so `isRunnableCandidate` rejects
  every card that has one and the alert names only dependency-free cards as runnable. The report
  still renders, still looks plausible, and tells the operator the queue is blocked on nothing in
  particular — which is why no default-board test could see it.

  Both directions are asserted in one case: a card whose dependency rests in the board's own complete
  lane must be RUNNABLE, and a card whose dependency is still in the hold lane must not be. Asserting
  only the first would pass against a predicate that had simply stopped checking dependencies.
  */
  it("treats a dependency resting in the board's RENAMED complete lane as satisfied", async () => {
    const todoSlim = Array.from({ length: 44 }, (_, i) => createTask({ id: `FN-T${i}`, column: "drafting" }));
    const inProgressSlim = [1, 2, 3].map((n) => createTask({ id: `FN-P${n}`, column: "brewing" }));
    const todoFull = [
      createTask({ id: "FN-SATISFIED", column: "drafting", priority: "urgent", dependencies: ["FN-DEP-SHIPPED"] }),
      createTask({ id: "FN-BLOCKED", column: "drafting", priority: "urgent", dependencies: ["FN-DEP-DRAFTING"] }),
      createTask({ id: "FN-FREE-1", column: "drafting", priority: "high" }),
      createTask({ id: "FN-FREE-2", column: "drafting", priority: "high" }),
      createTask({ id: "FN-FREE-3", column: "drafting", priority: "normal" }),
    ];
    const allTasks = [
      ...todoFull,
      createTask({ id: "FN-DEP-SHIPPED", column: "shipped" }),
      createTask({ id: "FN-DEP-DRAFTING", column: "drafting" }),
    ];
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockResolvedValue([]) };
    const reporter = new BacklogPressureReporter({
      store: createStore({
        todoSlim, inProgressSlim, todoFull, allTasks, insightStore,
        workflowIr: RENAMED_DEPENDENCY_IR, holdColumn: "drafting", wipColumn: "brewing",
      }),
      projectId: "/tmp/project",
      logger: { warn: vi.fn(), error: vi.fn() },
      now: () => Date.parse("2026-05-18T12:00:00.000Z"),
    });

    const result = await reporter.report();
    expect(result.alerted).toBe(true);
    const content = JSON.parse(insightStore.upsertInsight.mock.calls[0][1].content);
    const ids = content.candidates.map((candidate: { id: string }) => candidate.id);

    expect(ids).toContain("FN-SATISFIED");
    /* The paired negative: a dependency still waiting must still block. */
    expect(ids).not.toContain("FN-BLOCKED");
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-18:02 (found by BLINDING, not by the census):
  THE WIP RESOLVER IN THIS REPORTER WAS UNCOVERED — the census counts it as converted, and nothing
  in the tree could tell it from the literal it replaced.

  Measured with the #3214 procedure, one resolver at a time against this file's 11 cases:

      hold      -> ["todo"]                 2 failed   covered
      wip       -> ["in-progress"]          0 failed   UNCOVERED
      terminal  -> ["done","archived"]      1 failed   covered

  Every pre-existing renamed-board case here supplies `inProgressSlim` under the resolved wip lane
  AND asserts an outcome the wip count does not change, so blinding that one resolver was invisible.

  WHAT IT COSTS ON A RENAMED BOARD, which is why this is a real alert bug and not bookkeeping:
  `wipColumns` feeds `inProgressCount`, the DENOMINATOR of
  `ratio = todoCount / max(inProgressCount, 1)`. Against the literal, a board whose wip lane is
  `brewing` matches no rows, so busy in-progress work counts as ZERO, the ratio inflates to
  `todoCount`, and the backlog-pressure alert fires on a queue that is draining normally. The
  operator is paged that the board is jammed while agents are working through it.

  THE FIXTURE REACHES THE BRANCH (rule 2): 12 hold cards over 2 wip cards is a ratio of 6, UNDER the
  default threshold of 10, so the correct answer is "no alert". Blinded, the denominator collapses to
  1 and the ratio becomes 12 — over the threshold, past the candidate gate, and alerting. A fixture
  whose ratio cleared the threshold either way could not see this.

  ASSERTED ON THE SIDE EFFECT (rule 3): `upsertInsight` is what the alerting path DOES. Asserting
  only `alerted === false` would also pass if the run bailed early for an unrelated reason — a
  missing insight store, a cooldown hit, too few candidates — none of which involve the wip lane.
  */
  it("does NOT alert when a renamed WIP lane holds the in-progress work", async () => {
    /* 12 waiting cards in the renamed hold lane. */
    const todoSlim = Array.from({ length: 12 }, (_, i) =>
      createTask({ id: `FN-W${i}`, column: "drafting" }));
    /* 2 cards genuinely in progress, in the renamed wip lane the literal cannot see. */
    const inProgressSlim = [
      createTask({ id: "FN-BREW-1", column: "brewing" }),
      createTask({ id: "FN-BREW-2", column: "brewing" }),
    ];
    /* Dependency-free, so the blinded run reaches the alert rather than stopping at candidates. */
    const todoFull = todoSlim;
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockResolvedValue([]) };
    const reporter = new BacklogPressureReporter({
      store: createStore({
        todoSlim, inProgressSlim, todoFull, allTasks: todoSlim, insightStore,
        workflowIr: RENAMED_DEPENDENCY_IR, holdColumn: "drafting", wipColumn: "brewing",
      }),
      projectId: "/tmp/project",
      logger: { warn: vi.fn(), error: vi.fn() },
      now: () => Date.parse("2026-05-18T12:00:00.000Z"),
    });

    const result = await reporter.report();

    /* 12 / 2 = 6, under the threshold of 10. Against the literal this is 12 / 1 and alerts. */
    expect(result).toEqual({ alerted: false, reason: "under-threshold" });
    expect(insightStore.upsertInsight).not.toHaveBeenCalled();
  });

  /*
  THE PAIRED POSITIVE. The case above is a "does not fire" assertion, which a reporter that never
  fired at all would satisfy — including one broken so badly it always returns under-threshold. This
  pins that the SAME renamed board still alerts when the ratio genuinely warrants it, so the case
  above is measuring the wip lane rather than a dead reporter.
  */
  it("still alerts on the same renamed board when in-progress work really is thin", async () => {
    const todoSlim = Array.from({ length: 12 }, (_, i) =>
      createTask({ id: `FN-T${i}`, column: "drafting" }));
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockResolvedValue([]) };
    const reporter = new BacklogPressureReporter({
      store: createStore({
        todoSlim, inProgressSlim: [], todoFull: todoSlim, allTasks: todoSlim, insightStore,
        workflowIr: RENAMED_DEPENDENCY_IR, holdColumn: "drafting", wipColumn: "brewing",
      }),
      projectId: "/tmp/project",
      logger: { warn: vi.fn(), error: vi.fn() },
      now: () => Date.parse("2026-05-18T12:00:00.000Z"),
    });

    const result = await reporter.report();

    expect(result.alerted).toBe(true);
    expect(insightStore.upsertInsight).toHaveBeenCalledTimes(1);
  });
});
