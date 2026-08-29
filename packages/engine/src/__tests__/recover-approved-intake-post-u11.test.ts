/*
FNXC:RecoverApprovedIntakePostU11 2026-07-29-21:10 (U11 #2515 audit — U7's site 1088):

`recoverApprovedTask` is self-healing's recovery for a planner that wrote a good
PROMPT.md and then died before handing the card off. It gates on
`task.column !== "triage"`.

AUDIT ANSWERS for the coordinator's three questions:

  (a) Does it still fire for a default-workflow card?  NO. U11 (#2515) merged Todo
      into Planning keeping the id `todo`, so the default lineage declares no
      `triage` column and every default card fails this gate.

  (b) What silently stops happening?  Recovery of an APPROVED, already-written plan.
      The card is not stranded — triage's stale-planning sweeps still match `todo`
      and clear its status — but clearing the status makes the card an ordinary
      planning candidate again, so it is RE-PLANNED FROM SCRATCH. An approved spec
      is discarded and a fresh LLM planning pass is burned, every time, on the exact
      path built to avoid that (FN-1312: "auto-recovered specified task stuck in
      planning — moved to todo").

      Worth being precise about the severity: this is waste and lost work, not a
      stall. The card does keep moving.

  (c) Fix: resolve the INTAKE column from the task's own workflow.

The intake-ONLY scope is preserved, not widened: plan-in-place cards specified while
resting in the HOLD column are still out of reach of this path. That is a real
pre-existing gap, and widening it is a behavior change that does not belong in a
vocabulary fix. It is pinned below so it stays a decision rather than an accident.

The other four sites the drift review assigned me (613, 651, 741, 769) SURVIVE
#2515, because U11 kept the id `todo` and each of them tests `todo` as well as
`triage`. Measured, not assumed — they are asserted here so the audit is checkable
rather than a claim in a PR body.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

import { TriageProcessor } from "../triage.js";
import { planLog } from "../logger.js";

const WF = "custom:recovery-vocab";

/** Post-U11 default shape: ONE pre-implementation column carrying intake + hold. */
const MERGED = { intake: "todo", hold: "todo" };
/** A workflow that renamed it as well, so the fix cannot pass by naming `todo`. */
const RENAMED = { intake: "backlog", hold: "backlog" };

const REAL_SPEC = [
  "# Task: FN-001 - Real spec", "", "## Mission", "", "Do the thing.", "",
  "## Steps", "", "### Step 0: Implement", "- [ ] do the work", "",
].join("\n");

function ir(names: { intake: string; hold: string }): WorkflowIr {
  return {
    version: "v2", id: WF, name: WF, nodes: [], edges: [],
    columns: [
      {
        id: names.intake,
        name: "Planning",
        traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }],
      },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function createStore(task: Task, workflowIr: WorkflowIr): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  const store: Record<string, unknown> = {
    listTasks: vi.fn(async () => [task]),
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ requirePlanApproval: false } as Settings)),
    parseDependenciesFromPrompt: vi.fn(async () => []),
    parseStepsFromPrompt: vi.fn(async () => []),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    updateTask: vi.fn(async () => undefined),
    updateTaskAtomic: vi.fn(async (_id: string, patch: unknown) => {
      const next = typeof patch === "function" ? (patch as (t: Task) => Partial<Task> | null)(task) : patch;
      if (next) Object.assign(task, next);
      return task;
    }),
    moveTask: vi.fn(async () => undefined),
    moveTaskIf: vi.fn(async (_id: string, column: string) => ({ moved: true, task: { ...task, column } })),
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    readTaskForMove: vi.fn(async () => task),
    logEntry: vi.fn(async () => undefined),
    recordActivity: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    /*
    Main's `resolvePlannerLanes` resolves SYNCHRONOUSLY via
    `resolveTaskWorkflowIrSync` — the planner-lane reads happen inside synchronous
    handlers and predicates, so there is no await available. A fixture without it
    silently takes the legacy `{ intake: "triage" }` fallback, which reads as "the
    conversion does not work" rather than "the fake is incomplete".
    */
    /*
    FNXC:WorkflowResolvedColumns 2026-08-01-02:07 REDUNDANT:
    The `resolveTaskWorkflowIrSync` stub remains removed. Re-running
    `pnpm --filter @fusion/engine exec vitest run src/__tests__/recover-approved-intake-post-u11.test.ts --silent=passed-only --reporter=dot`
    passed 6/6. It was redundant because the async readers resolve the test workflow without it.
    FN-8648's corrected tally is six redundant, one deliberate DEFAULT-IR contrast, one masking site.
    */
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: workflowIr })),
    on: vi.fn(), off: vi.fn(),
  };
  return store as unknown as TaskStore;
}

describe("approved-plan recovery resolves the intake column (U11 #2515)", () => {
  let rootDir = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    rootDir = await mkdtemp(join(tmpdir(), "fusion-recovery-vocab-"));
    await mkdir(join(rootDir, ".fusion", "tasks", "FN-001"), { recursive: true });
    await writeFile(join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"), REAL_SPEC);
    vi.spyOn(planLog, "log").mockImplementation(() => {});
    vi.spyOn(planLog, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  const stuckPlanner = (column: string): Task => ({
    id: "FN-001", title: "t", description: "d", column, status: "planning",
    dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Task);

  async function recovers(names: { intake: string; hold: string }): Promise<boolean> {
    const task = stuckPlanner(names.intake);
    const store = createStore(task, ir(names));
    return new TriageProcessor(store, rootDir).recoverApprovedTask(task);
  }

  it("recovers a stuck planner in the MERGED planning column (the post-U11 default)", async () => {
    // Pre-fix this returned false for every default-workflow card: the gate named
    // `triage`, which U11 removed. The approved spec was then discarded and the card
    // re-planned from scratch by ordinary discovery.
    expect(await recovers(MERGED)).toBe(true);
  });

  it("recovers a stuck planner in a RENAMED planning column", async () => {
    expect(await recovers(RENAMED)).toBe(true);
  });

  it("STILL recovers a card sitting in the legacy `triage` column (the migration window)", async () => {
    /*
    FNXC:RecoverApprovedIntakePostU11 2026-07-29-23:20:
    THIS is what this PR uniquely adds. Main already resolves the intake lane, which
    fixed merged and renamed workflows — and silently broke the cards still SITTING in
    `triage`, the population U11's re-homing has not reached yet. Such a card resolves
    its intake to `todo`, fails the gate, and has its approved spec discarded: the
    stale-planning sweep clears the status and ordinary discovery re-plans it from
    scratch.

    `triage` remains a legal stored column id (R11), so recovery must accept both the
    resolved lane and the legacy one during the migration window.
    */
    const task = stuckPlanner("triage");
    const store = createStore(task, ir(MERGED));

    await expect(new TriageProcessor(store, rootDir).recoverApprovedTask(task)).resolves.toBe(true);
  });

  it("still refuses a card outside its own intake column — the gate is narrowed, not removed", async () => {
    const task = stuckPlanner("in-progress");
    const store = createStore(task, ir(MERGED));

    await expect(new TriageProcessor(store, rootDir).recoverApprovedTask(task)).resolves.toBe(false);
  });
});

/*
FNXC:RecoverApprovedIntakePostU11 2026-07-30-00:50 (PR #2593 review — greptile P1):
The legacy acceptance is SCOPED to an ORPHANED `triage` row. A custom workflow may
legitimately name a NON-intake lane `triage`, and accepting a planning-status card
from there would finalize its plan and move it to the hold lane — bypassing whatever
transition that column represents.

The migration case is precisely "the row sits in a column its workflow no longer
has", which is also what `reconcileUndeclaredTaskColumns` is about to re-home. When
the workflow DOES declare `triage`, its declared role governs.
*/
describe("legacy `triage` acceptance is scoped to orphaned rows", () => {
  let rootDir = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    rootDir = await mkdtemp(join(tmpdir(), "fusion-recovery-scope-"));
    await mkdir(join(rootDir, ".fusion", "tasks", "FN-001"), { recursive: true });
    await writeFile(join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"), REAL_SPEC);
    vi.spyOn(planLog, "log").mockImplementation(() => {});
    vi.spyOn(planLog, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  /** A workflow that names its REVIEW lane `triage` — legal, and not a planner lane. */
  function triageIsReviewIr(): WorkflowIr {
    return {
      version: "v2", id: WF, name: WF, nodes: [], edges: [],
      columns: [
        { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
        { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        // Deliberately named `triage`, but it is the REVIEW lane.
        { id: "triage", name: "Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
  }

  it("REFUSES a card in a `triage` column the workflow declares as a non-planner lane", async () => {
    const task = {
      id: "FN-001", title: "t", description: "d", column: "triage", status: "planning",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as Task;
    const store = createStore(task, triageIsReviewIr());

    await expect(new TriageProcessor(store, rootDir).recoverApprovedTask(task)).resolves.toBe(false);
  });

  it("still ACCEPTS a card in `triage` when the workflow declares no such column (migration window)", async () => {
    const task = {
      id: "FN-001", title: "t", description: "d", column: "triage", status: "planning",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as Task;
    const store = createStore(task, ir(MERGED));

    await expect(new TriageProcessor(store, rootDir).recoverApprovedTask(task)).resolves.toBe(true);
  });
});
