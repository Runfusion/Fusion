/*
FNXC:TriageLifecycleColumns 2026-07-28-11:10 (U7 / R3, R12 — workflow-owned lifecycle):

THE INVARIANT: triage discovers planning work, and hands a specified card off, by
the task's OWN workflow columns — never by the literal ids `triage` / `todo`.

WHY THIS FILE EXISTS. The program's per-file census (plan Problem Frame, 535
sites) covers `self-healing.ts` (U4), the executor/scheduler cluster (U5), and the
core policy modules (U6). `triage.ts` is in NONE of them, so its lifecycle-column
literals were unowned. Measured with the plan's own methodology (block and line
comments stripped, code lines only): a naive quoted-literal grep reports 50 sites,
but 35 of those are the agent ROLE string `"triage"`, not the column. The genuine
lifecycle-column surface is 15 — 12 planning-lane, 3 `column !== "done"` in
duplicate search. The 50 figure would over-count by 3.3x.

WHAT WAS ACTUALLY BROKEN on a workflow whose columns are renamed — and both of
these fail SILENTLY, which is the whole reason Phase B is sliced rather than swept:

  1. DISCOVERY never matched, so cards on that workflow were never planned at all.
     No error, no log: the filter simply returned nothing and the poll looked
     healthy.
  2. THE RELEASE MOVE targeted the literal `"todo"`, a column the workflow may not
     declare — which is precisely the R7 violation ("a stored task row pointing at
     a column no workflow declares") that `reconcileUndeclaredTaskColumns` exists
     to clean up after.

DIFFERENTIAL BY CONSTRUCTION. Every case runs the SAME scenario under two
vocabularies — the default ids and a renamed set where NO id collides with a legacy
literal — and asserts the outcomes match. A surviving `=== "todo"` cannot pass both
halves by luck, and the default half doubles as the no-regression proof.

DELIBERATELY OUT OF SCOPE, and listed so the gaps are not mistaken for coverage:
  - `taskColumnWakeHandler` / the planning-evacuation handler. Both are synchronous
    `task:updated` listeners; resolving an IR per event means a store read on every
    task update on the board. That needs a cache design, not a find-and-replace.
  - WIDENING `recoverApprovedTask` beyond the intake column. Its literal IS
    converted here (the renamed release below is unreachable otherwise), but its
    intake-ONLY scope is preserved exactly: plan-in-place cards specified while
    resting in the HOLD column stay unreachable by that recovery path. That is a
    real pre-existing gap; closing it is a behavior change and does not belong in a
    vocabulary conversion. It is pinned below so it is a recorded decision.
  - The three `column !== "done"` filters in duplicate search — a different role
    (complete), a different lane, no planning decision.
*/
import "./executor-test-helpers.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

import { TriageProcessor } from "../triage.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";
import { planLog } from "../logger.js";

const WF = "custom:planning-vocab";

/** The two vocabularies. Traits are identical; only the ids differ, so any
 *  behavioral difference is attributable to a surviving literal and nothing else. */
const DEFAULT_NAMES = { intake: "triage", hold: "todo", wip: "in-progress" };
/* No renamed id collides with a legacy column literal, so a stray `=== "todo"`
   cannot match by coincidence. */
const RENAMED = { intake: "backlog", hold: "drafting", wip: "building" };

function ir(names: { intake: string; hold: string; wip: string }): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    name: WF,
    columns: [
      { id: names.intake, name: "Intake", traits: [{ trait: "intake" }] },
      {
        id: names.hold,
        name: "Hold",
        traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }],
      },
      { id: names.wip, name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: names.intake },
      { id: "planning", kind: "prompt", column: names.hold, config: { seam: "planning" } },
      { id: "execute", kind: "prompt", column: names.wip, config: { seam: "execute" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "planning" },
      { from: "planning", to: "execute", condition: "success" },
      { from: "execute", to: "end", condition: "success" },
    ],
  } as unknown as WorkflowIr;
}

const REAL_SPEC = [
  "# Task: FN-001 - Real spec",
  "",
  "## Mission",
  "",
  "Do the thing.",
  "",
  "## Steps",
  "",
  "### Step 0: Implement",
  "- [ ] do the work",
  "",
].join("\n");

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Task",
    description: "desc",
    column: "triage",
    status: "planning",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function createStore(opts: {
  tasks: Task[];
  workflowIr: WorkflowIr;
  settings?: Partial<Settings>;
}): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  const { tasks } = opts;
  const byId = (id: string) => tasks.find((t) => t.id === id);
  const store: Record<string, unknown> = {
    getSettings: vi.fn().mockResolvedValue({
      pollIntervalMs: 600_000,
      maxConcurrent: 4,
      requirePlanApproval: false,
      ...opts.settings,
    } as Settings),
    listTasks: vi.fn(async (filter?: { column?: string }) =>
      (filter?.column ? tasks.filter((t) => t.column === filter.column) : tasks)),
    getTask: vi.fn(async (id: string) => byId(id)),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn(),
    updateTaskAtomic: vi.fn(async (id: string, patch: unknown) => {
      const live = byId(id);
      if (!live) return undefined;
      const next = typeof patch === "function"
        ? (patch as (t: Task) => Partial<Task> | null)(live)
        : (patch as Partial<Task> | null);
      if (next) Object.assign(live, next);
      return live;
    }),
    moveTask: vi.fn(),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const live = byId(id)!;
      return { moved: true, task: { ...live, column, status: null } };
    }),
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    readTaskForMove: vi.fn(async (id: string) => byId(id)),
    logEntry: vi.fn(),
    recordActivity: vi.fn().mockResolvedValue(undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: opts.workflowIr })),
    on: vi.fn(),
    off: vi.fn(),
  };
  return store as unknown as TaskStore;
}

describe("triage resolves its planning-lane columns from the task's workflow", () => {
  let rootDir = "";

  beforeEach(async () => {
    resetExecutorMocks();
    vi.clearAllMocks();
    rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-vocab-"));
    vi.spyOn(planLog, "log").mockImplementation(() => {});
    vi.spyOn(planLog, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  async function seedPrompt(taskId: string, content: string): Promise<void> {
    await mkdir(join(rootDir, ".fusion", "tasks", taskId), { recursive: true });
    await writeFile(join(rootDir, ".fusion", "tasks", taskId, "PROMPT.md"), content);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Discovery — which cards are planned at all
  // ───────────────────────────────────────────────────────────────────────────

  /** Drive one poll and report which task ids triage decided to specify. */
  async function discovered(names: { intake: string; hold: string; wip: string }): Promise<string[]> {
    const intakeCard = createTask({ id: "FN-INTAKE", column: names.intake, status: "planning" });
    // A hold-column card with no spec yet — see the ENOENT note below.
    const holdCard = createTask({ id: "FN-HOLD", column: names.hold, status: null });
    const elsewhere = createTask({ id: "FN-ELSEWHERE", column: names.wip, status: null });
    // FN-HOLD deliberately has NO PROMPT.md: the documented ENOENT branch treats a
    // missing spec as unplanned and admits the card, which is the plan-in-place /
    // Ideas-promotion shape the hold half of discovery exists to catch.
    const store = createStore({ tasks: [intakeCard, holdCard, elsewhere], workflowIr: ir(names) });
    const processor = new TriageProcessor(store, rootDir);
    const specified: string[] = [];
    vi.spyOn(processor as unknown as { specifyTask: (t: Task) => Promise<void> }, "specifyTask")
      .mockImplementation(async (t: Task) => { specified.push(t.id); });

    /*
    `poll()` early-returns unless the processor is running, so flipping the flag is
    what makes the pass happen at all. Preferred over `start()`: start() installs a
    real `setInterval` and store listeners, which this case does not exercise and
    which leak across tests.
    */
    (processor as unknown as { running: boolean }).running = true;
    await (processor as unknown as { poll: () => Promise<void> }).poll();

    return specified.sort();
  }

  it("discovers intake and hold cards under the DEFAULT vocabulary (no-regression half)", async () => {
    expect(await discovered(DEFAULT_NAMES)).toEqual(["FN-HOLD", "FN-INTAKE"]);
  });

  it("discovers the same cards under a RENAMED vocabulary", async () => {
    // Pre-conversion this returned [] — the literal filter matched nothing, silently,
    // so every card on a renamed workflow was invisible to planning forever.
    expect(await discovered(RENAMED)).toEqual(["FN-HOLD", "FN-INTAKE"]);
  });

  it("never discovers a card resting in the wip column, under either vocabulary", async () => {
    for (const names of [DEFAULT_NAMES, RENAMED]) {
      expect(await discovered(names)).not.toContain("FN-ELSEWHERE");
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. The release move — where a specified card lands
  // ───────────────────────────────────────────────────────────────────────────

  /** Run a finalize through the public recovery entry point and report the move target. */
  async function releaseTarget(names: { intake: string; hold: string; wip: string }): Promise<string | undefined> {
    const task = createTask({ id: "FN-001", column: names.intake, status: "planning" });
    await seedPrompt("FN-001", REAL_SPEC);
    const store = createStore({ tasks: [task], workflowIr: ir(names) });

    await new TriageProcessor(store, rootDir).recoverApprovedTask(task);

    const call = vi.mocked(store.moveTaskIf!).mock.calls[0];
    return call?.[1] as string | undefined;
  }

  it("releases into the workflow's HOLD column under the default vocabulary", async () => {
    expect(await releaseTarget(DEFAULT_NAMES)).toBe("todo");
  });

  it("releases into the workflow's HOLD column under a renamed vocabulary", async () => {
    // Pre-conversion this moved the card to the literal "todo" — a column this
    // workflow does not declare, i.e. exactly the R7 violation
    // `reconcileUndeclaredTaskColumns` exists to clean up after.
    expect(await releaseTarget(RENAMED)).toBe("drafting");
  });

  it("does not move a card that is ALREADY resting in its own hold column (plan-in-place)", async () => {
    // The same-column skip must key on the resolved hold column, not on `!== "todo"`.
    // Keyed on the literal, a renamed plan-in-place card was moved to a foreign
    // column instead of being left where it already was.
    const task = createTask({ id: "FN-001", column: RENAMED.hold, status: "planning" });
    await seedPrompt("FN-001", REAL_SPEC);
    const store = createStore({ tasks: [task], workflowIr: ir(RENAMED) });

    // `recoverApprovedTask` gates on the intake column, so drive the hold-column
    // shape through the same path the plan-in-place cards actually take.
    await new TriageProcessor(store, rootDir).recoverApprovedTask(task);

    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. A gap this slice deliberately PRESERVES rather than fixes
  // ───────────────────────────────────────────────────────────────────────────

  it("still refuses to recover a hold-column card — the pre-existing intake-only gate, pinned not fixed", async () => {
    /*
    `recoverApprovedTask` gates on the INTAKE column only. Plan-in-place cards are
    specified while resting in the HOLD column (Coding (Ideas), and any
    `needs-replan` revision on the default workflow), so this recovery path cannot
    reach them — a stuck planner on such a card is recovered by nothing here.

    Converting the literal to the intake ROLE preserves that gap exactly; widening
    it to intake-or-hold would be a behavior change, and a vocabulary slice is the
    wrong place to make one. Pinned so the gap is a recorded decision rather than an
    accident, and so whoever fixes it has a failing test to flip.
    */
    const task = createTask({ id: "FN-001", column: RENAMED.hold, status: "planning" });
    await seedPrompt("FN-001", REAL_SPEC);
    const store = createStore({ tasks: [task], workflowIr: ir(RENAMED) });

    await expect(
      new TriageProcessor(store, rootDir).recoverApprovedTask(task),
    ).resolves.toBe(false);
  });
});
