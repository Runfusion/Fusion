import { describe, expect, it, vi } from "vitest";
import { TriageProcessor } from "../triage.js";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-19:10:
THE STARTUP STALE-PLANNING SWEEP, on a RENAMED board.

A card can carry `status: "planning"` while triage specifies it in place. A crash or restart before
planning completes leaves that status set, so a startup sweep clears it — otherwise the card occupies
a planning admission slot PERMANENTLY and new triage work never gets admitted.

WHY THIS FILE EXISTS. The sweep's lane read was converted from `resolvePlannerLanes(store, "")` (an
empty task id, so it could only ever answer with the DEFAULT board) to a project-level
`resolveProjectColumnsForRoles(store, ["intake", "hold"])`. No test could observe that conversion:
neutering the resolver to an empty set left all 25 triage test files green (375/375).

THE SITE IS SEED-THEN-UNION, which changes what a blind means:

    const sweepColumns = [...new Set(["triage", "todo", ...projectPlannerColumns])];

Blinding the resolver to its legacy pair `["triage","todo"]` is a no-op FOR A DEFAULT BOARD — the
seed already contains both, so the union is unchanged. It is NOT a no-op for a renamed board, where
the resolver is the only contributor of `drafting`. Both blinds therefore fail the renamed cases
below, and the empty-set blind is the stricter one because it also models a resolver that returns
nothing at all.

(I predicted the legacy blind would be a no-op here and it was not. Recorded because the seed-then-
union caution is real but narrower than it first looks: it hides a defect only while every lane you
assert on is already in the seed. Assert on a lane that is not, and the union stops protecting it.)

WHAT BREAKS WITHOUT THE CONVERSION. On a board whose planner lane is `drafting`, the sweep queries
`{triage, todo}`, never lists the card, and never clears its stale `planning`. The slot is held
forever — the exact permanent-occupancy failure the sweep exists to prevent.

DIFFERENTIAL. Both vocabularies run the same workflow SHAPE with identical traits; only the ids
differ, and no renamed id collides with a legacy literal. The default-vocabulary run is the control:
it passes with or without the conversion (its lane is in the literal seed), so a generic break in
this path cannot hide here.
*/

const WF = "custom:renamed-planner-lane";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "task",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/**
 * One merged planner column carrying BOTH planner roles, which is the post-#2515 default shape:
 * `intake` and `hold` are the same column, not two.
 */
function ir(plannerColumn: string): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      {
        id: plannerColumn,
        label: "Planner",
        traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }],
      },
      { id: "building", label: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", label: "Complete", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function createStore(tasks: Task[], workflowIr: WorkflowIr, settings: Partial<Settings> = {}) {
  const resolved = { maxConcurrent: 10, maxWorktrees: 10, ...settings };
  const selection = { workflowId: WF, stepIds: [] };
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) Object.assign(task, patch);
    return task as Task;
  });

  const store = {
    /* Honours the `column` filter; a mock returning every task cannot detect a wrong lane. */
    listTasks: vi.fn(async (query?: { column?: string }) =>
      (query?.column ? tasks.filter((task) => task.column === query.column) : tasks)),
    getSettings: vi.fn(async () => resolved),
    updateTask,
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    logEntry: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/project"),
    getTasksDir: vi.fn(() => "/tmp/project/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: workflowIr })),
    /* Without this the resolver hands back legacy ids only, and the conversion is untestable. */
    listWorkflowDefinitions: vi.fn(async () => [{ ir: workflowIr }]),
  } as unknown as TaskStore;

  return { store, updateTask };
}

/**
 * A card resting in the board's PLANNER lane with a stale `planning` status, reported in role terms
 * so both vocabularies are directly comparable.
 */
async function staleePlanningScenario(plannerColumn: string) {
  const stale = makeTask({ id: "FN-STALE", column: plannerColumn, status: "planning" } as Partial<Task>);
  const { store, updateTask } = createStore([stale], ir(plannerColumn));

  const processor = new TriageProcessor(store, "/tmp/project");
  /*
  The sweep is private and `start()` would also spin pollers and timers that are not what these cases
  are about. Invoked directly so a failure here can only be the sweep.
  */
  await (processor as unknown as { clearStaleSpecifyingStatuses(): Promise<void> }).clearStaleSpecifyingStatuses();
  processor.stop();

  return { updateTask, stale };
}

describe("triage startup stale-planning sweep reaches a RENAMED planner lane", () => {
  it("default vocabulary: a stale planning card in the planner lane is cleared", async () => {
    const { updateTask, stale } = await staleePlanningScenario("todo");
    expect(updateTask).toHaveBeenCalledWith("FN-STALE", { status: null });
    expect(stale.status).toBeNull();
  });

  it("renamed vocabulary: a stale planning card in the planner lane is cleared", async () => {
    const { updateTask, stale } = await staleePlanningScenario("drafting");
    expect(updateTask).toHaveBeenCalledWith("FN-STALE", { status: null });
    expect(stale.status).toBeNull();
  });

  it("both vocabularies reach the SAME outcome — no column-id literal survives on this path", async () => {
    const defaultRun = await staleePlanningScenario("todo");
    const renamedRun = await staleePlanningScenario("drafting");
    expect(renamedRun.stale.status).toBe(defaultRun.stale.status);
    expect(renamedRun.stale.status).toBeNull();
  });

  it("the legacy planner ids stay in the sweep even when the workflow does not name them", async () => {
    /*
    The union keeps `triage`/`todo` deliberately: pre-U11 and Coding (Ideas) rows can rest there on a
    board whose workflow declares neither. Dropping them in favour of the resolved lanes alone would
    strand exactly those rows, so this pins the legacy half of the union too.
    */
    const legacyRow = makeTask({ id: "FN-LEGACY", column: "triage", status: "planning" } as Partial<Task>);
    const { store, updateTask } = createStore([legacyRow], ir("drafting"));
    const processor = new TriageProcessor(store, "/tmp/project");
    await (processor as unknown as { clearStaleSpecifyingStatuses(): Promise<void> }).clearStaleSpecifyingStatuses();
    processor.stop();

    expect(updateTask).toHaveBeenCalledWith("FN-LEGACY", { status: null });
  });
});
