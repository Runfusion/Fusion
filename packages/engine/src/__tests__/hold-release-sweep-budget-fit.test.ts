/*
FNXC:CapacitySlotCost 2026-10-29-12:02 (RUFU-698 Step 2):
Board-scale fit for the hold-release sweep, measured through the REAL reservation closure.

The field report (rozvrh, 2026-10-16) read `slot=12074ms` of a 16884 ms sweep with `released=0` and
`budget-truncated unevaluated=29`, and inferred "about 2 s per reservation" from those counters. Steps
1-3 of that report shipped per-call attribution, once-per-pass capacity facts, and truncation rotation
(`b7bfb9243a`), but nothing automated ever drove the production reservation closure at board scale: the
earlier scale test stubbed `reserveSlot` (a stub measures the stub) and the gated Postgres bench never
reaches a reservation at all.

These scenarios drive `Scheduler.schedule()`, so the code measured here is the code that runs in
production. Measurement classes (recorded in `docs/diagnostics.md`):
 - Class B — real closure + counting fake store: measured store ROUND-TRIPS per reservation.
 - Class C — Class B with a fixed per-read latency charged to the injected clock: a FIT verdict only,
   never a production latency figure.
Prohibited by the card's Measurement Contract and therefore absent here: a stubbed `reserveSlot`, any
cost taken from a pass that performed zero reservations, real Postgres, temp-dir PROMPT.md files, real
timers, and any change to `SWEEP_BUDGET_MS`.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import { schedulerLog } from "../logger.js";
import { resetHoldReleaseInstrumentation } from "../execution/hold-release.js";

const WF = "builtin:coding";

/** Rotation state is keyed by sweep project id, so every store in this file must report the same one. */
const SWEEP_PROJECT = "rufu-698-fit";

/** The production default, asserted to be what the pass actually runs under. */
const SWEEP_BUDGET_MS = 10_000;

const PASSED_PLAN_REVIEW = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "passed" as const,
  source: "node" as const,
  phase: "pre-merge" as const,
};

/** Capacity-release hold lane → WIP lane bounded by `maxConcurrent` → completion. */
function fitIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", name: "todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function task(id: string, column: Task["column"], overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: "",
    column,
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    // The plan-premise gate reads `task.prompt` when the store exposes no `getTasksDir`, so the fixture
    // gives every card a readable plan without touching the filesystem (no temp PROMPT.md files).
    prompt: "# Planned\n\n## Mission\nImplement the approved work.\n",
    workflowStepResults: column === "todo" ? [PASSED_PLAN_REVIEW] : [],
    ...overrides,
  } as Task;
}

/**
 * Board builder. `candidates` is the population the sweep must decide — the axis every number here is a
 * function of. `fillers` are completed rows that make the board read like the field's 267-642 task
 * projects rather than an empty one.
 */
function board(params: { candidates: number; fillers?: number; unapprovedFrom?: number }): Task[] {
  const tasks: Task[] = [];
  for (let i = 0; i < (params.fillers ?? 0); i += 1) tasks.push(task(`FILL-${String(i).padStart(4, "0")}`, "done"));
  for (let i = 0; i < params.candidates; i += 1) {
    const refused = params.unapprovedFrom !== undefined && i >= params.unapprovedFrom;
    tasks.push(task(
      `FIT-${String(i).padStart(4, "0")}`,
      "todo",
      // No passing plan-review row → readiness refuses at `awaiting-approval`, before the reservation line.
      refused ? { workflowStepResults: [] } : {},
    ));
  }
  return tasks;
}

/**
 * Class C instrument: one store read costs `perReadMs` of sweep budget, charged to the clock the
 * scheduler hands the sweep. With `perReadMs = 0` the same run is a pure Class B read count.
 * No real time passes, so the scenarios stay deterministic and fast.
 */
function chargeableClock(params: { perReadMs?: number; startMs?: number } = {}) {
  let t = params.startMs ?? 1_000_000;
  let reads = 0;
  const perReadMs = params.perReadMs ?? 0;
  return {
    now: () => t,
    charge: () => { reads += 1; t += perReadMs; },
    get readCount() { return reads; },
  };
}

interface PassOutcome {
  line: string;
  /** Parsed from the structured sweep line: these counters reach the outside world nowhere else. */
  slotCalls: number;
  released: number;
  held: number;
  budgetTruncated: boolean;
  unevaluatedCount: number | undefined;
  rotatedDeferredCount: number | undefined;
  /** Counted store round-trips in this pass (Class B). */
  reads: number;
  byMethod: Record<string, number>;
  /** Slot child buckets, to name the dominant leg if a board ever stops fitting. */
  slotDetail: Record<string, number>;
}

/**
 * One store, one scheduler, many passes — because truncation rotation is a CROSS-PASS property and a
 * fresh store per pass would erase exactly the state under test.
 */
function createFitRun(params: {
  tasks: Task[];
  settings?: Partial<Settings>;
  perReadMs?: number;
}): { store: TaskStore; clock: ReturnType<typeof chargeableClock>; pass: () => Promise<PassOutcome>; tasks: Task[] } {
  const { tasks } = params;
  const clock = chargeableClock({ perReadMs: params.perReadMs });
  const counts: Record<string, number> = {};
  const byId = (id: string) => tasks.find((t) => t.id === id);
  const settings = {
    // Free capacity by default: the report's board had `capacity_refused=0`, and a full pool refuses
    // at the sweep's own pre-check, which never reaches the leg this card is about.
    maxConcurrent: 10_000,
    maxWorktrees: 10_000,
    groupOverlappingFiles: true,
    ...params.settings,
  } as Settings;

  const count = (name: string) => { counts[name] = (counts[name] ?? 0) + 1; clock.charge(); };
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const t = byId(id);
    if (t) Object.assign(t, patch);
    return t as Task;
  });
  const moveTask = vi.fn(async (id: string, column: Task["column"]) => {
    const t = byId(id);
    if (t) t.column = column;
    return t as Task;
  });

  const store = {
    listTasks: vi.fn(async () => { count("listTasks"); return tasks; }),
    getSettings: vi.fn(async () => { count("getSettings"); return settings; }),
    updateSettings: vi.fn(async () => settings),
    getTask: vi.fn(async (id: string) => { count("getTask"); return byId(id) ?? null; }),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: WF, stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => { count("selection"); return { workflowId: WF, stepIds: [] }; }),
    getWorkflowDefinition: vi.fn(async () => { count("workflowDefinition"); return { ir: fitIr() }; }),
    getWorkflowSettingsProjectId: vi.fn(() => SWEEP_PROJECT),
    parseFileScopeFromPrompt: vi.fn(async (id: string) => { count("parseFileScope"); return [`packages/engine/src/${id}.ts`]; }),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => { count("handoffMarker"); return null; }),
    // The scheduler's unlinked-missions advisory runs in the same poll; give it an empty mission store
    // so a failing reporter cannot hide behind (or masquerade as) this card's failure.
    getMissionStore: vi.fn(() => ({ listMissions: async () => [] })),
    updateTask,
    updateTaskAtomic: vi.fn(async (id: string, updater: (live: Task) => Partial<Task> | null | undefined) => {
      count("updateTaskAtomic");
      const t = byId(id);
      if (!t) throw new Error(`Task ${id} missing`);
      const patch = await updater(t);
      if (patch) Object.assign(t, patch);
      return t;
    }),
    moveTask,
    moveTaskIf: vi.fn(async (
      id: string,
      column: Task["column"],
      predicate: (live: Task) => boolean | Promise<boolean>,
    ) => {
      count("moveTaskIf");
      const t = byId(id);
      if (!t) return { task: t as unknown as Task, moved: false };
      if (!(await predicate(t)) || t.column === column) return { task: t, moved: false };
      await moveTask(id, column);
      return { task: t, moved: true };
    }),
    transitionQueuedEpisode: vi.fn(async (
      id: string,
      transition: { blockedBy: string | null; overlapBlockedBy: string | null },
    ) => {
      count("transitionQueuedEpisode");
      const t = byId(id)!;
      await updateTask(id, { status: "queued", blockedBy: transition.blockedBy, overlapBlockedBy: transition.overlapBlockedBy });
      return { appended: true, task: t };
    }),
    logEntry: vi.fn(async () => { count("logEntry"); }),
    recordRunAuditEvent: vi.fn(async () => { count("recordRunAuditEvent"); }),
    getRootDir: vi.fn(() => "/tmp/rufu-698-fit"),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;

  const scheduler = new Scheduler(store, { holdReleaseClock: clock.now });
  (scheduler as unknown as { running: boolean }).running = true;

  return { store, clock, tasks, pass: async () => runOnePass() };

  async function runOnePass(): Promise<PassOutcome> {
    const captured: string[] = [];
    const push = (m: unknown) => { captured.push(String(m)); };
    // The sweep line is emitted at warn (slow or truncated), log (something released), or debug
    // (neither), so a cost assertion has to capture all three levels.
    const spies = [
      vi.spyOn(schedulerLog, "warn").mockImplementation(push as never),
      vi.spyOn(schedulerLog, "log").mockImplementation(push as never),
      vi.spyOn(schedulerLog, "debug").mockImplementation(push as never),
    ];
    const readsBefore = clock.readCount;
    try {
      await scheduler.schedule();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const line = captured.find((l) => l.includes("Hold-release sweep:")) ?? "";
    const unevaluated = /budget-truncated unevaluated=(\d+)/.exec(line);
    const rotated = /rotated-deferred=(\d+)/.exec(line);
    return {
      line,
      slotCalls: Number(/slot-calls=(\d+)/.exec(line)?.[1] ?? -1),
      released: Number(/released=(\d+)/.exec(line)?.[1] ?? -1),
      held: Number(/held=(\d+)/.exec(line)?.[1] ?? -1),
      budgetTruncated: unevaluated !== null,
      unevaluatedCount: unevaluated ? Number(unevaluated[1]) : undefined,
      rotatedDeferredCount: rotated ? Number(rotated[1]) : undefined,
      reads: clock.readCount - readsBefore,
      byMethod: { ...counts },
      slotDetail: parseGroup(line, "slot-detail") ?? {},
    };
  }
}

/** Parse `name=123ms` pairs out of one printed group, e.g. the `slot-detail=(…)` breakdown. */
function parseGroup(line: string, group: string): Record<string, number> | undefined {
  const match = new RegExp(`${group}=\\(([^)]*)\\)`).exec(line);
  if (!match) return undefined;
  const out: Record<string, number> = {};
  for (const part of match[1].split(", ")) {
    const [name, value] = part.split("=");
    if (name && value?.endsWith("ms")) out[name] = Number(value.slice(0, -2));
  }
  return out;
}

const columnOf = (tasks: Task[], id: string): string => tasks.find((t) => t.id === id)!.column;
const idsIn = (tasks: Task[], column: string): number => tasks.filter((t) => t.column === column).length;

/*
Derivation of the Class C charges, from measured numbers rather than a guess. The sweep charges budget
only for reads it performs inside its own window, and at 5 ms/read a 300-candidate pass reported
`6015ms (… evaluate 6005ms … slot=4505ms)`, i.e. **~1 203 charged in-sweep reads** (~4 per candidate;
the rest of the ~3 011 reads the counting store sees belong to other scheduler consumers). The board
therefore fits the production default budget iff a read costs at most `10_000 ÷ 1_203` ≈ **8.3 ms**.
`FIT_CHARGE_MS` sits well inside that bound and `TRUNCATE_CHARGE_MS` well outside it, so the pair proves
the model is sensitive instead of tuned to be trivially green.
*/
const FIT_CHARGE_MS = 1;
const TRUNCATE_CHARGE_MS = 12;

describe("RUFU-698 Step 2: hold-release sweep budget fit through the real reservation leg", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
    vi.spyOn(Scheduler.prototype as unknown as { validateTaskFilesystem: unknown }, "validateTaskFilesystem")
      .mockResolvedValue({ valid: true } as never);
  });

  it("S1: bounds per-reservation store round-trips as the board grows (Class B, real closure)", async () => {
    /*
    Cost of the real reservation leg per candidate, measured rather than inferred. Attribution is
    DIFFERENTIAL, because the leg cannot be bracketed from outside the closure: the same 300-candidate
    board is run twice, once with free capacity (every candidate reaches the line, `slot-calls=300`)
    and once with the pool full (the sweep's own capacity pre-check refuses before the line,
    `slot-calls=0`). Identical per-candidate evaluation work in both; the only difference is the leg,
    so the read difference belongs to it.
    */
    const single = createFitRun({ tasks: board({ candidates: 1 }) });
    const one = await single.pass();

    const free = createFitRun({ tasks: board({ candidates: 300 }) });
    const many = await free.pass();

    const fullBoard = board({ candidates: 300 });
    fullBoard.unshift(task("OCC-000", "in-progress", { status: "executing", workflowStepResults: [] }));
    const refused = createFitRun({ tasks: fullBoard, settings: { maxConcurrent: 1 } });
    const none = await refused.pass();

    // The leg actually ran, so these are admissible cost numbers under the Measurement Contract.
    expect(one.slotCalls).toBe(1);
    expect(many.slotCalls).toBe(300);
    expect(none.slotCalls).toBe(0);

    // Differential leg cost: reads the reservation adds, per reservation.
    const legReads = many.reads - none.reads;
    expect(legReads).toBeGreaterThan(0);
    const readsPerReservation = legReads / many.slotCalls;
    /*
    This is the number that retires the report's "about 2 s per call" inference: one reservation costs
    single-digit store round-trips. It is a WORK SHAPE, not a latency — production latency for those
    round-trips is Class A and only the gated bench can produce it. Scope note: the differential spans
    the whole pass, so it counts the reservation leg together with the release it performs, and it
    excludes the board-wide reads both runs pay identically (the per-candidate IR resolve costs ~3 reads
    per candidate in both, which is exactly why a differential and not a raw total is the honest form).
    */
    expect(readsPerReservation).toBeLessThan(20);

    /*
    Boundedness as the board grows, asserted as a RATIO and not a raw total: unrelated scheduler
    consumers legitimately read the board in the same pass, so totals move for reasons this card is
    not about. What must not come back is the per-candidate fan-out Step 2 removed (measured on the
    shared-claim board at 1 247 selection reads for 2 candidates, 5 002 on a 1 000-card board). If a
    regression reintroduced it, reads per reservation would grow with the board instead of shrinking.
    */
    const readsPerCallOne = one.reads / one.slotCalls;
    const readsPerCallMany = many.reads / many.slotCalls;
    expect(readsPerCallMany).toBeLessThan(readsPerCallOne);
  });

  it("S2: a 300-candidate board fits the production default budget and releases (Class C fit verdict)", async () => {
    /*
    Class C: the per-read charge is a MODEL (`FIT_CHARGE_MS`, derived above), so the verdict this
    scenario is allowed to state is "a ~300-candidate board fits the default 10 s budget iff a store
    read costs at most ~3.3 ms". It is not a production latency claim and must not be quoted as one.
    The budget itself is untouched — production passes no `budgetMs`, so the sweep runs on
    `SWEEP_BUDGET_MS`.
    */
    const run = createFitRun({ tasks: board({ candidates: 300 }), perReadMs: FIT_CHARGE_MS });
    const result = await run.pass();

    expect(result.slotCalls).toBeGreaterThan(0);
    expect(result.budgetTruncated).toBe(false);
    expect(result.unevaluatedCount).toBeUndefined();
    expect(result.released).toBe(300);
    // The release is real, not a counter: the queue head actually left the hold lane.
    expect(columnOf(run.tasks, "FIT-0000")).toBe("in-progress");
    expect(idsIn(run.tasks, "todo")).toBe(0);
    // The fit verdict is the sweep's OWN reported duration against the production default budget.
    const sweepMs = Number(/Hold-release sweep: project=[^:]*: (\d+)ms/.exec(result.line)?.[1] ?? -1);
    expect(sweepMs).toBeGreaterThan(0);
    expect(sweepMs).toBeLessThan(SWEEP_BUDGET_MS);
  });

  it("S3: a charge past the budget truncates at board scale and hands the tail priority next pass", async () => {
    /*
    Truncation is induced by the modelled charge crossing `SWEEP_BUDGET_MS` mid-loop, never by
    `budgetMs: 1`: a deadline that small dies in the prefetch preamble, which records no deferred tail
    at all (`logPreambleTruncation`), so the rotation half would go untested.
    */
    const tasks = board({ candidates: 300 });
    const run = createFitRun({ tasks, perReadMs: TRUNCATE_CHARGE_MS });

    const first = await run.pass();
    expect(first.slotCalls).toBeGreaterThan(0);
    expect(first.budgetTruncated).toBe(true);
    expect(first.unevaluatedCount).toBeGreaterThan(0);
    expect(first.unevaluatedCount!).toBeLessThan(300);
    // The reported starvation shape: a truncated pass that released nothing while capacity sat free.
    const starvedTailCount = idsIn(tasks, "todo");
    expect(starvedTailCount).toBe(first.unevaluatedCount!);

    /*
    The next pass starts with the cards the previous pass never reached. Asserted on board state, not
    only on the counter: fewer cards remain in the hold lane, so the tail was actually evaluated.
    */
    const second = await run.pass();
    expect(second.rotatedDeferredCount).toBe(first.unevaluatedCount);
    expect(idsIn(tasks, "todo")).toBeLessThan(starvedTailCount);
  });

  it("S4: the rotation inversion is bounded to one pass at board scale", async () => {
    const tasks = board({ candidates: 300 });
    const run = createFitRun({ tasks, perReadMs: TRUNCATE_CHARGE_MS });

    const first = await run.pass();
    expect(first.budgetTruncated).toBe(true);

    const second = await run.pass();
    expect(second.rotatedDeferredCount).toBeGreaterThan(0);
    // The pass that consumed the tail finished inside its budget, which ends the inversion by definition.
    expect(second.budgetTruncated).toBe(false);

    /*
    Third pass: no tail survives, so a pass that evaluates everyone must NOT keep claiming a rotation.
    If the deferred-tail map were never cleared, this field would lie forever and a one-time unfairness
    would be reported as a permanent one.
    */
    const third = await run.pass();
    expect(third.rotatedDeferredCount).toBeUndefined();
  });

  it("S5: candidates refused before the line cost zero reservations, on a clean and a mixed board", async () => {
    /*
    The guard that keeps a future "skip it for free" from being reported as a release attempt: the
    reservation count is charged only to cards that actually reached the line. `groupOverlappingFiles`
    is off here so file-scope overlap can never be the reason a card was refused.
    */
    const refusedOnly = createFitRun({
      tasks: board({ candidates: 120, unapprovedFrom: 0 }),
      settings: { groupOverlappingFiles: false },
    });
    const clean = await refusedOnly.pass();
    expect(clean.slotCalls).toBe(0);
    expect(clean.released).toBe(0);
    // Refused before the line, and visibly held rather than silently dropped.
    expect(clean.held).toBe(120);
    expect(columnOf(refusedOnly.tasks, "FIT-0000")).toBe("todo");

    const mixedBoard = board({ candidates: 240, unapprovedFrom: 90 });
    const mixed = createFitRun({ tasks: mixedBoard, settings: { groupOverlappingFiles: false } });
    const result = await mixed.pass();
    expect(result.slotCalls).toBe(90);
    // Never more reservations than candidates that could have reached the line.
    expect(result.slotCalls).toBeLessThanOrEqual(90);
    expect(result.released).toBe(90);
    expect(idsIn(mixedBoard, "in-progress")).toBe(90);
    expect(idsIn(mixedBoard, "todo")).toBe(150);
  });

  it("S6-guard: the fit seam's slot detail names a leg, so a fit failure would be diagnosable", async () => {
    /*
    If a board ever stops fitting, the verdict has to name the leg. This pins that the detail group is
    populated on the real-closure seam at board scale (the gated PG bench historically reported an empty
    one because it performed no reservations at all).
    */
    const run = createFitRun({ tasks: board({ candidates: 30 }), perReadMs: FIT_CHARGE_MS });
    const result = await run.pass();
    expect(result.slotCalls).toBe(30);
    expect(Object.keys(result.slotDetail).length).toBeGreaterThan(0);
    const sum = Object.values(result.slotDetail).reduce((acc, ms) => acc + ms, 0);
    expect(sum).toBeGreaterThanOrEqual(0);
  });
});
