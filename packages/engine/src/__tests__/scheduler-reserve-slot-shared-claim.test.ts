/*
FNXC:CapacitySlotCost 2026-10-16-20:50 (RUFU-698 Step 2):
The Step-1 attribution proved WHERE a seconds-slow reservation lives (`slot=13770ms` of a 30038ms pass)
but the cost itself is per-candidate re-derivation of facts that cannot change inside one sweep pass:

 - `getFinalClaimSnapshot()` re-ran a whole-board `listTasks` plus both capacity dimensions per
   candidate — its memo lived inside the `reserveSlot` closure, so it memoized ONE CANDIDATE, not a pass;
 - each dimension calls `enrichedTopLevelAgentTasksFromStore`, which built a fresh IR/selection cache per
   call, so two dimensions × every candidate re-resolved the workflow IR and re-enriched every row.

Measured on this harness (250-card board, one pass):
 | candidates reaching the admission gate        | 1    | 2      |
 | whole-board claim derivations      before     | 1    | 2      |
 | whole-board claim derivations      after      | 1    | 1      |
 | selection reads                    before     | 997  | 1 247  |
 | selection reads                    after      | 748  | 749    |
The second candidate used to cost a whole extra board fan-out (250 reads here, 1 000 on a 1 000-card
board, where the totals measured 4 001 → 5 002); it now costs one read. A full pool is the worst case,
because EVERY candidate takes the refusal path — which is how `released=0` ate 13.7 s.

These tests pin the once-per-pass shape on the two store reads that cost the time, and pin what must NOT
change: the released/held vector and the refusal of a full pool. A memoized baseline must never turn
into over-admission, which is why the full-pool case is asserted alongside the read counts.
*/
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import { getPromptPath } from "../execution/spec-staleness.js";

/*
A card released into processing passes the plan-premise gate by reading its authoritative PROMPT.md at
`getTasksDir()/<id>/PROMPT.md` (RUFU-319). A fixture whose tasks dir was never created models a state no
real card can be in, so every fixture card gets a readable plan and the release is decided by capacity
logic instead of by a missing document.
*/
const tasksRoot = mkdtempSync(join(tmpdir(), "fusion-rufu698-claim-"));
afterAll(() => rmSync(tasksRoot, { recursive: true, force: true }));

const PASSED_PLAN_REVIEW = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "passed" as const,
  source: "node" as const,
  phase: "pre-merge" as const,
};

function codingIr(): WorkflowIr {
  return {
    version: "v2",
    id: "builtin:coding",
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", name: "todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "in-review", name: "in-review", traits: [{ trait: "review" }] },
      { id: "done", name: "done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function makeTask(id: string, column: Task["column"], overrides: Partial<Task> = {}): Task {
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
    workflowStepResults: column === "todo" ? [PASSED_PLAN_REVIEW] : [],
    ...overrides,
  } as Task;
}

/** The board shape the field sweep ran on: hundreds of rows, only two of them candidates. */
function board(params: { fillers: number; occupant?: boolean }): Task[] {
  const tasks: Task[] = [];
  for (let index = 0; index < params.fillers; index += 1) tasks.push(makeTask(`FILL-${String(index).padStart(3, "0")}`, "done"));
  if (params.occupant) tasks.push(makeTask("FN-OCCUPANT", "in-progress", { status: "executing" }));
  tasks.push(makeTask("FN-A", "todo"));
  tasks.push(makeTask("FN-B", "todo"));
  return tasks;
}

interface Counters {
  /** Every whole-board read the final-claim derivation performs (it is the only `slim: false` consumer). */
  claimSnapshotReads: number;
  /** Uncached per-task workflow-selection reads, which the enrichment fan-out multiplies. */
  selectionReads: number;
  listTasksCalls: number;
}

function createStore(params: {
  tasks: Task[];
  counters: Counters;
  settings?: Partial<Settings>;
  /** Models a durable move that lost a race: the reservation is undone and the sweep continues to the next card. */
  refuseHeadMoveFor?: string;
}): TaskStore {
  const { tasks, counters } = params;
  for (const task of tasks) {
    mkdirSync(join(tasksRoot, task.id), { recursive: true });
    writeFileSync(getPromptPath(tasksRoot, task.id), `# ${task.title}\n\nPlanned fixture plan for ${task.id}.\n`, "utf8");
  }
  const settings: Settings = { maxConcurrent: 1, maxWorktrees: 1, groupOverlappingFiles: true, ...params.settings } as Settings;
  const byId = (id: string) => tasks.find((task) => task.id === id);
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const task = byId(id);
    if (task) Object.assign(task, patch);
    return task as Task;
  });
  const moveTask = vi.fn(async (id: string, column: Task["column"]) => {
    const task = byId(id);
    if (task) task.column = column;
    return task as Task;
  });
  const moveTaskIf = vi.fn(async (
    id: string,
    column: Task["column"],
    predicate: (live: Task) => boolean | Promise<boolean>,
  ) => {
    const task = byId(id);
    if (!task) return { task: task as unknown as Task, moved: false };
    if (!(await predicate(task)) || task.column === column) return { task, moved: false };
    if (id === params.refuseHeadMoveFor) return { task, moved: false };
    await moveTask(id, column);
    return { task, moved: true };
  });

  return {
    listTasks: vi.fn(async (opts?: Record<string, unknown>) => {
      counters.listTasksCalls += 1;
      /*
      The sweep's own board read asks for `derive: false, excludeLog: true`; the final-claim snapshot is
      the only consumer that asks for `slim: false`. Counting on the option measures the derivation this
      card is about rather than a total that unrelated reads legitimately move.
      */
      if (opts?.slim === false) counters.claimSnapshotReads += 1;
      return tasks;
    }),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async () => settings),
    /* Distinct scopes per card, so file-scope overlap never decides these fixtures. */
    parseFileScopeFromPrompt: vi.fn(async (id: string) => [`packages/engine/src/${id}.ts`]),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => {
      counters.selectionReads += 1;
      return { workflowId: "builtin:coding", stepIds: [] };
    }),
    updateTask,
    updateTaskAtomic: vi.fn(async (id: string, updater: (live: Task) => Partial<Task> | null | undefined) => {
      const task = byId(id);
      if (!task) throw new Error(`Task ${id} missing`);
      const patch = await updater(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    moveTask,
    moveTaskIf,
    getTask: vi.fn(async (id: string) => byId(id) ?? null),
    logEntry: vi.fn(async () => undefined),
    transitionQueuedEpisode: vi.fn(async (
      id: string,
      transition: { blockedBy: string | null; overlapBlockedBy: string | null },
    ) => {
      const task = byId(id)!;
      await updateTask(id, { status: "queued", blockedBy: transition.blockedBy, overlapBlockedBy: transition.overlapBlockedBy });
      return { appended: true, task };
    }),
    getRootDir: vi.fn(() => "/tmp/rufu-698-claim"),
    getTasksDir: vi.fn(() => tasksRoot),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

async function runPass(params: {
  tasks: Task[];
  counters: Counters;
  settings?: Partial<Settings>;
  refuseHeadMoveFor?: string;
}): Promise<void> {
  const store = createStore(params);
  const scheduler = new Scheduler(store);
  (scheduler as unknown as { running: boolean }).running = true;
  await scheduler.schedule();
}

const stateOf = (tasks: Task[], ids: string[]): string[] =>
  ids.map((id) => {
    const task = tasks.find((candidate) => candidate.id === id)!;
    return `${task.id}:${task.column}`;
  });

describe("RUFU-698 Step 2: the reservation leg derives pass-invariant facts once per pass", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Scheduler.prototype as unknown as { validateTaskFilesystem: unknown }, "validateTaskFilesystem")
      .mockResolvedValue({ valid: true } as never);
  });

  it("derives the claim snapshot once even when two candidates reach the admission gate", async () => {
    /*
    Two candidates only reach the gate in one pass when the queue head's release does not consume the
    pool — here the head's durable move loses its race (`moved: false`), the sweep undoes its
    reservation, and the next card is evaluated too. Two gates, still one derivation per pass.
    */
    const counters: Counters = { claimSnapshotReads: 0, selectionReads: 0, listTasksCalls: 0 };
    const tasks = board({ fillers: 247 });
    await runPass({ tasks, counters, refuseHeadMoveFor: "FN-A" });

    expect(stateOf(tasks, ["FN-A", "FN-B"])).toEqual(["FN-A:todo", "FN-B:in-progress"]);
    expect(counters.claimSnapshotReads).toBeLessThanOrEqual(1);
    /*
    Upper bound, not an equality: unrelated scheduler consumers legitimately read the board in the same
    pass (the pre-sweep worktree-holder fan-out alone costs 250 here, measured 748 total). What must NOT
    come back is the per-candidate fan-out this card removed, which measured 1 247 selection reads on
    this board and 5 002 on a 1 000-card board.
    */
    expect(counters.selectionReads).toBeLessThanOrEqual(1_100);
  });

  it("keeps the released/held vector of a free-capacity pass and never over-admits a full pool", async () => {
    const freeCounters: Counters = { claimSnapshotReads: 0, selectionReads: 0, listTasksCalls: 0 };
    const freeBoard = board({ fillers: 247 });
    await runPass({ tasks: freeBoard, counters: freeCounters });
    // maxConcurrent=1 admits the queue-order head and nothing else; the second card waits in the hold lane.
    expect(stateOf(freeBoard, ["FN-A", "FN-B"])).toEqual(["FN-A:in-progress", "FN-B:todo"]);
    expect(freeCounters.claimSnapshotReads).toBeLessThanOrEqual(1);

    // The memoized baseline must not become over-admission: a pool the snapshot reports as full stays full.
    const fullCounters: Counters = { claimSnapshotReads: 0, selectionReads: 0, listTasksCalls: 0 };
    const fullBoard = board({ fillers: 247, occupant: true });
    await runPass({ tasks: fullBoard, counters: fullCounters });
    expect(stateOf(fullBoard, ["FN-A", "FN-B", "FN-OCCUPANT"]))
      .toEqual(["FN-A:todo", "FN-B:todo", "FN-OCCUPANT:in-progress"]);
  });
});
