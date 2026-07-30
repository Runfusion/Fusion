import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../scheduler.js";
import { seedPlannedSpec } from "./_planned-spec-fixture.js";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

/*
FNXC:TaskDispatch 2026-07-30-22:40:
A PARKED CARD IS NEVER DISPATCHED — pinned at the layer that actually owns the refusal.

WHY THIS FILE EXISTS. `executor-prompt.test.ts` asserted this invariant as
`expect(mockedCreateFnAgent).not.toHaveBeenCalled()` after calling `executor.execute(task)`
directly. That is the wrong layer: `execute()` holds no pause gate at all — neither `executeCore`
nor the workflow-graph executor consults `paused`/`userPaused` before starting a session. The
assertion was red at `origin/main~250` as well as at HEAD, so it never described shipped behaviour,
and it made a true statement about the system look like a live safety hole.

The refusal is the SCHEDULER's. It is enforced twice, and the second one is the load-bearing one:

  1. Candidacy is keyed on both flags (scheduler.ts:138) — `userPaused` is a durable operator stop
     even when legacy `paused` is false, so every dispatch selector treats either as parked.
  2. The row is RE-READ immediately before dispatch and refused if it comes back parked
     (scheduler.ts:2086). This is what closes the race the first check cannot: an operator who
     pauses a card after it was selected but before the agent starts.

Driven through `schedule()` rather than by calling the predicate, because a test that calls the
guard directly cannot tell whether the dispatch path still consults it — which is exactly how the
executor-prompt version came to assert a layer that had stopped being asked.

`userPaused: true` with `paused` absent is covered on purpose: AGENTS.md makes it a durable stop in
its own right, and a guard written as `task.paused` alone would pass every other case in this file.
*/

const WF = "custom:paused-dispatch";

/*
FNXC:TaskDispatch 2026-07-31-01:35 (PR #2779 review — greptile P2):
Each `createStore` mints a temp tasks dir for the planned spec, so without this every local and CI
run leaves `fusion-paused-dispatch-*` directories behind in the OS temp dir forever.

Removed by exact recorded path — never by scanning the temp root. AGENTS.md forbids an unbounded
walk of $TMPDIR//var/folders, and this file has no need of one: it created these paths, so it knows
them. `force` keeps teardown quiet if a case never got as far as seeding. Per-test rather than per-file so
nothing accumulates even across a long run.
*/
const seededTaskDirs: string[] = [];

afterEach(() => {
  for (const dir of seededTaskDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-PARKED",
    title: "parked card",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [{
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "passed" as const,
      source: "node" as const,
      phase: "pre-merge" as const,
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

const IR = {
  version: "v2",
  id: WF,
  nodes: [],
  edges: [],
  columns: [
    { id: "todo", label: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "in-review", label: "Review", traits: [{ trait: "humanReview" }, { trait: "mergeBlocker" }] },
    { id: "done", label: "Done", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

/**
 * `freshTask` is what the pre-dispatch re-read returns. Defaulting it to the listed row models the
 * ordinary case; passing a different one models the operator who pauses mid-selection.
 */
function createStore(task: Task, freshTask: Task | null = null, settings: Partial<Settings> = {}): TaskStore {
  const resolved = { maxConcurrent: 10, maxWorktrees: 10, groupOverlappingFiles: false, ...settings };
  const selection = { workflowId: WF, stepIds: [] };
  /*
  A REAL planned spec on disk. The card rests in a hold/intake column, where FN-7648 refuses to
  release anything still carrying a bootstrap seed — so without this the control never dispatches
  and all three refusal cases pass vacuously. That is not hypothetical: the control caught exactly
  that on the first run of this file. `seedPlannedSpec` verifies its own output against the real
  `isUnplannedSeedPrompt` predicate, so a future change to the heuristic fails loudly here.
  */
  const tasksDir = mkdtempSync(join(tmpdir(), "fusion-paused-dispatch-"));
  seededTaskDirs.push(tasksDir);
  /*
  FNXC:TestHygiene 2026-07-31-02:30 (PR #2779 review — greptile):
  Every `createStore` call seeds a real spec on disk, and nothing removed it, so each local and CI
  run left another `fusion-paused-dispatch-*` directory in the OS temp root forever. Tracked and
  removed in `afterEach` below rather than swept later: the project forbids the recursive temp-root
  scan that finding stale fixtures would otherwise require, so the only safe cleanup is the one that
  remembers the exact paths it created.
  */
  allocatedFixtureDirs.push(tasksDir);
  /*
  The moves MUTATE the row, because the release path is `moveTaskIf(hold -> wip, predicate)` and a
  stub that always answers `moved: false` makes the hold release unobservable — the control then
  reports "not dispatched" for a card nothing ever refused.
  */
  const moveTask = vi.fn(async (_id: string, column: Task["column"]) => {
    task.column = column;
    return task;
  });
  const moveTaskIf = vi.fn(async (
    id: string,
    column: Task["column"],
    predicate: (live: Task) => boolean | Promise<boolean>,
  ) => {
    if (!(await predicate(task)) || task.column === column) return { task, moved: false };
    return { task: await moveTask(id, column), moved: true };
  });
  const store = {
    listTasks: vi.fn(async () => [task]),
    getSettings: vi.fn(async () => resolved),
    updateSettings: vi.fn(async () => resolved),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    moveTask,
    moveTaskIf,
    getTask: vi.fn(async () => freshTask ?? task),
    logEntry: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/project"),
    getTasksDir: vi.fn(() => tasksDir),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: IR })),
  } as unknown as TaskStore;
  seedPlannedSpec(store as unknown as { getTasksDir(): string }, task.id, { title: task.title, description: task.description });
  return store;
}

async function dispatchAttempted(store: TaskStore): Promise<boolean> {
  const scheduler = new Scheduler(store);
  (scheduler as unknown as { running: boolean }).running = true;
  await scheduler.schedule();
  return (store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(
    (call: unknown[]) => call[1] === "in-progress",
  );
}

/*
FNXC:TestHygiene 2026-07-31-02:30 (PR #2779 review — greptile):
Exact paths only — see the note at the allocation site for why this cannot be a temp-root sweep.
*/
const allocatedFixtureDirs: string[] = [];

afterEach(() => {
  for (const dir of allocatedFixtureDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the scheduler refuses to dispatch a parked card", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(
      Scheduler.prototype as never as { validateTaskFilesystem: () => unknown },
      "validateTaskFilesystem",
    ).mockResolvedValue({ valid: true } as never);
  });

  /* The control. Without it, a scheduler that dispatches NOTHING would pass every case below. */
  it("dispatches an unparked ready card (control)", async () => {
    expect(await dispatchAttempted(createStore(makeTask()))).toBe(true);
  });

  it("refuses a card parked with the legacy `paused` flag", async () => {
    expect(await dispatchAttempted(createStore(makeTask({ paused: true })))).toBe(false);
  });

  it("refuses a card parked with `userPaused` alone — a durable operator stop", async () => {
    expect(await dispatchAttempted(createStore(makeTask({ userPaused: true })))).toBe(false);
  });

  /*
  The race the candidacy check cannot close: the card was selectable when listed and is parked by
  the time the agent would start. Only the pre-dispatch re-read catches this.
  */
  it("refuses when the card is paused AFTER selection but BEFORE dispatch", async () => {
    const listed = makeTask();
    const parkedByOperator = makeTask({ userPaused: true });
    expect(await dispatchAttempted(createStore(listed, parkedByOperator))).toBe(false);
  });
});
