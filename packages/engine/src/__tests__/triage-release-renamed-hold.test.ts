/*
FNXC:WorkflowLifecycleColumns 2026-07-29-08:15 (U11 conversion — triage planner lanes):

Triage's planning HANDOFF releases a finished card out of the planner column into
the backlog, and it targeted the literal `"todo"`. For a workflow that names its
hold column anything else, the release move sends the card to a column that
workflow does not declare — and after U11 deletes `todo` from the builtins, it
sends every card to a column that does not exist at all.

This is the load-bearing site of the eight in triage.ts: the other seven decide
whether a card is IN a planner lane (latency or a missed sweep if wrong), while
this one performs the move that ends planning. If it fails, a card sits in the
planner column holding a finished spec — the exact symptom FN-8361 and the
handoff-outcome work were about.

Reuses the `recoverApprovedTask` seam, which is the one public method that reaches
the release move without a live planning session.

Written against the literal implementation and observed FAILING first.
*/
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

import { TriageProcessor } from "../triage.js";
import { planLog } from "../logger.js";

const WF = "custom:wf";

const REAL_SPEC = [
  "# Task: FN-001 - Real spec",
  "",
  "## Context",
  "Some context that is long enough to clear deterministic validation checks.",
  "",
  "## Steps",
  "1. Implement the thing",
  "2. Verify the thing",
  "",
  "## File Scope",
  "- packages/engine/src/triage.ts",
].join("\n");

/** Hold is `drafting`, intake is `inbox` — no `todo` column exists. */
function renamedIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", name: "inbox", traits: [{ trait: "intake" }] },
      { id: "drafting", name: "drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/** The builtin shape, for the regression floor. */
function defaultIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "triage", name: "triage", traits: [{ trait: "intake" }] },
      { id: "todo", name: "todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-29-16:05 (P0 audit — #2515):
The MERGED default lineage as #2515 actually shipped it: ONE pre-implementation
column, id `todo`, carrying intake AND hold. This is the shape that broke
`recoverApprovedTask`, whose guard was a bare `task.column !== "triage"`.
*/
function mergedDefaultIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Task",
    description: "desc",
    column: "inbox",
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

function createStore(task: Task, ir: WorkflowIr | null): { store: TaskStore; moveTaskIf: ReturnType<typeof vi.fn> } {
  const selection = { workflowId: WF, stepIds: [] };
  const moveTaskIf = vi.fn(async (_id: string, column: string) => ({
    moved: true,
    task: { ...task, column, status: null },
  }));
  const store: Record<string, unknown> = {
    on: vi.fn(),
    off: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(async (id: string) => (id === task.id ? task : undefined)),
    getSettings: vi.fn().mockResolvedValue({ requirePlanApproval: false } as Settings),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn(),
    updateTaskAtomic: vi.fn(async (_id: string, patch: unknown) => {
      const next = typeof patch === "function"
        ? (patch as (t: Task) => Partial<Task> | null)(task)
        : (patch as Partial<Task> | null);
      if (next) Object.assign(task, next);
      return task;
    }),
    moveTask: vi.fn(),
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    readTaskForMove: vi.fn(async (id: string) => (id === task.id ? task : undefined)),
    recordActivity: vi.fn().mockResolvedValue(undefined),
    moveTaskIf,
    logEntry: vi.fn(),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => (ir ? { ir } : null)),
    /*
    FNXC:WorkflowResolvedColumns 2026-08-01-02:07 REDUNDANT:
    THE SYNC READER STUB IS GONE, and its absence is the point. Re-running
    `pnpm --filter @fusion/engine exec vitest run src/__tests__/triage-release-renamed-hold.test.ts --silent=passed-only --reporter=dot`
    passed 5/5; its existing mutation check fails 1/4 when the release target reverts to the sync read.

    This harness fed `resolveTaskWorkflowIrSync` the test's own IR — the shape this repo's learnings
    call out as feeding the broken reader the right answer. In production that reader answers with the
    DEFAULT board for every task, so the suite proved the release LOGIC while being structurally
    unable to notice that the real call site resolved nothing.

    The release target now resolves through the async path (`getTaskWorkflowSelectionAsync` +
    `getWorkflowDefinition`, both mocked below), which is what production actually takes. Removing the
    stub is what makes these cases evidence about production rather than about the fixture.
    */
  };
  return { store: store as unknown as TaskStore, moveTaskIf };
}

describe("triage planning handoff releases into the workflow's hold column", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-release-"));
    await mkdir(join(rootDir, ".fusion", "tasks", "FN-001"), { recursive: true });
    await writeFile(join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"), REAL_SPEC);
    vi.spyOn(planLog, "log").mockImplementation(() => {});
    vi.spyOn(planLog, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("releases into the RENAMED hold column, not the literal todo", async () => {
    const task = createTask();
    const { store, moveTaskIf } = createStore(task, renamedIr());

    await new TriageProcessor(store, rootDir).recoverApprovedTask(task);

    expect(moveTaskIf).toHaveBeenCalledWith("FN-001", "drafting", expect.any(Function));
    expect(moveTaskIf).not.toHaveBeenCalledWith("FN-001", "todo", expect.any(Function));
  });

  it("still releases into todo for the builtin workflow (regression floor)", async () => {
    const task = createTask({ column: "triage" });
    const { store, moveTaskIf } = createStore(task, defaultIr());

    await new TriageProcessor(store, rootDir).recoverApprovedTask(task);

    expect(moveTaskIf).toHaveBeenCalledWith("FN-001", "todo", expect.any(Function));
  });

  it("falls back to todo for a workflow with NO column vocabulary", async () => {
    /* Conservative: a v1 / column-less IR has no hold role to resolve, so the
       release must behave exactly as before this conversion rather than guessing.
       (A store that cannot return an IR at all bails earlier in finalize, before
       the release — so the column-less IR is the case that actually reaches here.) */
    const task = createTask({ column: "triage" });
    const v1 = { version: "v1", id: WF, nodes: [], edges: [] } as unknown as WorkflowIr;
    const { store, moveTaskIf } = createStore(task, v1);

    await new TriageProcessor(store, rootDir).recoverApprovedTask(task);

    expect(moveTaskIf).toHaveBeenCalledWith("FN-001", "todo", expect.any(Function));
  });

  it("P0: admits a MERGED-lineage card sitting in the Planning column (#2515)", async () => {
    /*
    THE STALL. `recoverApprovedTask` opened with a bare `task.column !== "triage"`.
    #2515 merged Todo into Planning on the default lineage, so every default card
    now sits in `todo` and this guard rejected all of them — an approved plan whose
    finalize was interrupted was never released, and nothing else owns that card.

    `triage` stayed a legal id, so nothing threw; the guard just stopped matching.
    The assertion is the RETURN VALUE, because on a merged lineage the card is
    already where the release would send it — so "no move issued" is what BOTH the
    broken and the fixed code do, and only the outcome discriminates.
    */
    const task = createTask({ column: "todo" });
    const { store, moveTaskIf } = createStore(task, mergedDefaultIr());

    const recovered = await new TriageProcessor(store, rootDir).recoverApprovedTask(task);

    expect(recovered).toBe(true);
    expect(moveTaskIf).not.toHaveBeenCalled();
  });

  it("does NOT move a card already resting in the hold column", async () => {
    /*
    The U11 shape, and the reason this conversion matters beyond renaming: once
    triage carries the capacity hold, planning happens IN the hold column, so a
    finished card is already where the release would send it. The guard must
    recognise that and skip the move rather than issue a same-column move.
    */
    const task = createTask({ column: "drafting" });
    const { store, moveTaskIf } = createStore(task, renamedIr());

    await new TriageProcessor(store, rootDir).recoverApprovedTask(task);

    expect(moveTaskIf).not.toHaveBeenCalled();
  });
});
