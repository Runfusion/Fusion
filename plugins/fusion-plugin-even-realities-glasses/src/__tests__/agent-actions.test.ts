import { describe, expect, it, vi } from "vitest";
import {
  acceptReview,
  approvePlan,
  requestReview,
  retryTask,
  returnToAgent,
  startWork,
} from "../agent-actions.js";
import { GlassesInputError } from "../quick-capture.js";

type FakeTask = {
  id: string;
  column: string;
  status?: string | null;
  description: string;
  title?: string;
  updatedAt: string;
  assigneeUserId?: string | null;
  assignedAgentId?: string | null;
  stuckKillCount?: number | null;
};

function makeTask(overrides: Partial<FakeTask> = {}): FakeTask {
  return {
    id: "FN-1",
    column: "todo",
    status: null,
    description: "task",
    title: "task",
    updatedAt: "2026-01-01T00:00:00.000Z",
    assigneeUserId: "u1",
    assignedAgentId: "agent-1",
    stuckKillCount: 0,
    ...overrides,
  };
}

function createDeps(task: FakeTask) {
  const state = { ...task };
  const getTask = vi.fn(async (id: string) => (id === state.id ? { ...state } : null));
  const moveTask = vi.fn(async (id: string, column: string) => {
    if (id !== state.id) throw new Error("missing task");
    state.column = column;
  });
  const updateTask = vi.fn(async (id: string, updates: Record<string, unknown>) => {
    if (id !== state.id) throw new Error("missing task");
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete (state as Record<string, unknown>)[key];
      } else {
        (state as Record<string, unknown>)[key] = value;
      }
    }
  });
  return {
    taskStore: { getTask, moveTask, updateTask },
    pluginId: "fusion-plugin-even-realities-glasses",
    state,
    getTask,
    moveTask,
    updateTask,
  };
}

async function expectInputError(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toBeInstanceOf(GlassesInputError);
  await expect(promise).rejects.toMatchObject({ status });
}

describe("startWork", () => {
  it("moves allowed tasks to in-progress and returns task card", async () => {
    const deps = createDeps(makeTask({ column: "todo", status: null }));
    const result = await startWork({ taskId: "FN-1" }, deps as never);
    expect(deps.moveTask).toHaveBeenCalledWith("FN-1", "in-progress");
    expect(result.card.kind).toBe("task");
    expect(result.task.column).toBe("in-progress");
  });

  it("returns 409 for disallowed status/column with no mutation", async () => {
    const deps = createDeps(makeTask({ column: "triage", status: "planning" }));
    await expectInputError(startWork({ taskId: "FN-1" }, deps as never), 409);
    expect(deps.moveTask).not.toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])('returns 400 for invalid taskId: %p', async (taskId) => {
    const deps = createDeps(makeTask());
    await expectInputError(startWork({ taskId }, deps as never), 400);
  });

  it("returns 404 for unknown task", async () => {
    const deps = createDeps(makeTask());
    await expectInputError(startWork({ taskId: "FN-999" }, deps as never), 404);
  });
});

describe("requestReview", () => {
  it("moves in-progress task to in-review", async () => {
    const deps = createDeps(makeTask({ column: "in-progress" }));
    const result = await requestReview({ taskId: "FN-1" }, deps as never);
    expect(deps.moveTask).toHaveBeenCalledWith("FN-1", "in-review");
    expect(result.task.column).toBe("in-review");
  });

  it("returns 409 for wrong column", async () => {
    const deps = createDeps(makeTask({ column: "todo" }));
    await expectInputError(requestReview({ taskId: "FN-1" }, deps as never), 409);
    expect(deps.moveTask).not.toHaveBeenCalled();
  });
});

describe("approvePlan", () => {
  it("moves then clears status in order", async () => {
    const deps = createDeps(makeTask({ column: "triage", status: "awaiting-approval" }));
    const result = await approvePlan({ taskId: "FN-1" }, deps as never);
    expect(deps.moveTask).toHaveBeenCalledTimes(1);
    expect(deps.updateTask).toHaveBeenCalledTimes(1);
    expect(deps.moveTask.mock.invocationCallOrder[0]).toBeLessThan(deps.updateTask.mock.invocationCallOrder[0]);
    expect(result.task.column).toBe("todo");
    expect(result.task.status == null).toBe(true);
  });

  it("returns 409 for wrong status", async () => {
    const deps = createDeps(makeTask({ column: "triage", status: "planning" }));
    await expectInputError(approvePlan({ taskId: "FN-1" }, deps as never), 409);
    expect(deps.moveTask).not.toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
  });
});

describe("acceptReview", () => {
  it("clears status and assignee on in-review task", async () => {
    const deps = createDeps(makeTask({ column: "in-review", status: "awaiting-user-review" }));
    const result = await acceptReview({ taskId: "FN-1" }, deps as never);
    expect(deps.updateTask).toHaveBeenCalledTimes(1);
    expect(deps.moveTask).not.toHaveBeenCalled();
    expect(result.task.status == null).toBe(true);
    expect(result.task.assigneeUserId == null).toBe(true);
  });

  it("returns 409 for wrong column", async () => {
    const deps = createDeps(makeTask({ column: "todo" }));
    await expectInputError(acceptReview({ taskId: "FN-1" }, deps as never), 409);
    expect(deps.updateTask).not.toHaveBeenCalled();
  });
});

describe("returnToAgent", () => {
  it("clears assignment fields then moves to todo", async () => {
    const deps = createDeps(makeTask({ column: "in-review", status: "failed" }));
    const result = await returnToAgent({ taskId: "FN-1" }, deps as never);
    expect(deps.updateTask).toHaveBeenCalledTimes(1);
    expect(deps.moveTask).toHaveBeenCalledTimes(1);
    expect(deps.updateTask.mock.invocationCallOrder[0]).toBeLessThan(deps.moveTask.mock.invocationCallOrder[0]);
    expect(result.task.column).toBe("todo");
    expect(result.task.assigneeUserId == null).toBe(true);
    expect(result.task.status == null).toBe(true);
    expect(result.task.assignedAgentId == null).toBe(true);
  });

  it("returns 409 for wrong column", async () => {
    const deps = createDeps(makeTask({ column: "todo" }));
    await expectInputError(returnToAgent({ taskId: "FN-1" }, deps as never), 409);
    expect(deps.updateTask).not.toHaveBeenCalled();
    expect(deps.moveTask).not.toHaveBeenCalled();
  });
});

describe("retryTask", () => {
  it.each([
    {
      name: "in-review failed branch",
      task: makeTask({ column: "in-review", status: "failed" }),
      expectMove: false,
      expectedColumn: "in-review",
      expectedStatus: null,
    },
    {
      name: "triage planning branch",
      task: makeTask({ column: "triage", status: "planning", stuckKillCount: 0 }),
      expectMove: false,
      expectedColumn: "triage",
      expectedStatus: "needs-replan",
    },
    {
      name: "triage stuck-killed-count branch",
      task: makeTask({ column: "triage", status: null, stuckKillCount: 1 }),
      expectMove: false,
      expectedColumn: "triage",
      expectedStatus: "needs-replan",
    },
    {
      name: "general failed branch",
      task: makeTask({ column: "todo", status: "stuck-killed" }),
      expectMove: true,
      expectedColumn: "todo",
      expectedStatus: null,
    },
  ])("applies $name", async ({ task, expectMove, expectedColumn, expectedStatus }) => {
    const deps = createDeps(task);
    const result = await retryTask({ taskId: "FN-1" }, deps as never);
    expect(deps.updateTask).toHaveBeenCalledTimes(1);
    if (expectMove) {
      expect(deps.moveTask).toHaveBeenCalledWith("FN-1", "todo");
    } else {
      expect(deps.moveTask).not.toHaveBeenCalled();
    }
    expect(result.task.column).toBe(expectedColumn);
    expect(result.task.status ?? null).toBe(expectedStatus);
  });

  it("returns 409 for healthy task", async () => {
    const deps = createDeps(makeTask({ column: "in-progress", status: null }));
    await expectInputError(retryTask({ taskId: "FN-1" }, deps as never), 409);
    expect(deps.updateTask).not.toHaveBeenCalled();
    expect(deps.moveTask).not.toHaveBeenCalled();
  });
});

/*
FNXC:PluginLifecycleColumns 2026-07-30-03:20 (U11 #2515 audit — unowned plugin sites):

These operator actions gated on `column === "triage"`. U11 (#2515) merged Todo into
Planning KEEPING the id `todo` and DELETING `triage`, so on the default lineage:

  approvePlan  — REFUSED for every card. An awaiting-approval card now sits in `todo`,
                 the gate demands `triage`, so the operator's approve action from the
                 glasses surface fails with a conflict on a perfectly valid card.
  retryTask    — its triage-retry branch never fires, so a stuck/needs-replan card
                 cannot be retried from the glasses at all.
  startWork    — SURVIVES, because it already accepted `todo` as well.

That asymmetry is the tell: the one gate written to accept both ids kept working, and
the two written against a single id broke. `plugins/` is in no unit's file list and no
drift-review assignment.

The fix accepts the PRE-IMPLEMENTATION LANE rather than one id, resolving the task's
own workflow when the plugin's store can (it depends on `@fusion/core`) and falling
back to both legacy ids when it cannot. The fallback is why these cases assert the
default vocabulary too.
*/
describe("post-U11 planning-column gates", () => {
  it("approvePlan accepts an awaiting-approval card in the MERGED planning column", async () => {
    // Pre-fix: conflict. The card is valid and the operator's action just failed.
    const deps = createDeps(makeTask({ column: "todo", status: "awaiting-approval" }));

    const result = await approvePlan({ taskId: "FN-1" }, deps as never);

    expect(result.task.column).toBe("todo");
    expect(deps.updateTask).toHaveBeenCalled();
  });

  it("approvePlan still accepts a legacy `triage` card (migration window)", async () => {
    const deps = createDeps(makeTask({ column: "triage", status: "awaiting-approval" }));

    await expect(approvePlan({ taskId: "FN-1" }, deps as never)).resolves.toBeTruthy();
  });

  it("approvePlan still REFUSES a card that has left the planning lane", async () => {
    // The other side, so "always accepts" cannot pass for "accepts the lane".
    const deps = createDeps(makeTask({ column: "in-progress", status: "awaiting-approval" }));

    await expectInputError(approvePlan({ taskId: "FN-1" }, deps as never), 409);
  });

  it("retryTask reaches its planning-lane branch for a card in the MERGED column", async () => {
    // Pre-fix the branch was unreachable for default-lineage cards, so a stuck card
    // could not be retried from this surface at all.
    const deps = createDeps(makeTask({ column: "todo", status: "stuck-killed", stuckKillCount: 2 }));

    await retryTask({ taskId: "FN-1" }, deps as never);

    expect(deps.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({ status: "needs-replan" }));
  });

  it("startWork keeps accepting both ids (it already did — the control)", async () => {
    for (const column of ["todo", "triage"]) {
      const deps = createDeps(makeTask({ column, status: null }));
      await expect(startWork({ taskId: "FN-1" }, deps as never)).resolves.toBeTruthy();
    }
  });
});

/*
FNXC:PluginLifecycleColumns 2026-07-30-05:10 (PR #2607 review — greptile P1 x2):

Two over-reaches in my own first version, both found by review:

  1. DESTINATIONS stayed literal while the GATES were converted. On a renamed workflow
     that is WORSE than the original bug: the gate now admits the card and then moves it
     into a column the workflow does not declare. Half a conversion moved the failure
     from "refuses valid work" to "puts work where nothing renders it".

  2. The legacy-id acceptance was UNSCOPED, so a workflow naming its review or wip lane
     `triage`/`todo` had those cards authorized as planning work.

These drive a store that CAN resolve a workflow, which the default fixture cannot — the
plugin store is narrowed, so without the workflow methods every earlier case silently
exercised the legacy fallback rather than the resolved path.
*/
function createResolvingDeps(task: FakeTask, ir: unknown) {
  const base = createDeps(task);
  const selection = { workflowId: "wf-custom", stepIds: [] };
  return {
    ...base,
    taskStore: {
      ...base.taskStore,
      getTaskWorkflowSelection: () => selection,
      getTaskWorkflowSelectionAsync: async () => selection,
      getWorkflowDefinition: async () => ({ ir }),
    },
  };
}

const renamedIr = {
  version: "v2", id: "wf-custom", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
    { id: "shipped", name: "Done", traits: [{ trait: "complete" }] },
  ],
};

/** A workflow that assigns the LEGACY id `todo` to its REVIEW lane. Legal, and not planning. */
const todoIsReviewIr = {
  version: "v2", id: "wf-custom", name: "todo-is-review", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    /*
    The `merge` trait is REQUIRED for this to be a resolvable review lane, and that
    detail is the finding: `resolveLifecycleColumns` derives `review` from `merge`, not
    from `merge-blocker`/`human-review`. My first fixture omitted it, so `review` came
    back undefined, `declaredIds` did not contain `todo`, and the legacy acceptance
    applied — the test failed and was RIGHT to.

    (That gap — a column whose traits map to no role being invisible to a role-only
    check — is CLOSED below by reading the IR's declared column ids directly. It did not
    need a core change after all; it needed me to read an input that was already in
    reach. See "a declared column is declared even when it carries no role".)
    */
    { id: "todo", name: "Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }, { trait: "merge" }] },
    { id: "shipped", name: "Done", traits: [{ trait: "complete" }] },
  ],
};

describe("resolved lanes drive destinations, not just gates", () => {
  it("startWork moves a renamed card to the workflow's OWN wip column", async () => {
    // Pre-fix: admitted, then moved to the literal `in-progress` — a column this
    // workflow does not declare.
    const deps = createResolvingDeps(makeTask({ column: "backlog", status: null }), renamedIr);

    const result = await startWork({ taskId: "FN-1" }, deps as never);

    expect(deps.moveTask).toHaveBeenCalledWith("FN-1", "building");
    expect(result.task.column).toBe("building");
  });

  it("approvePlan moves a renamed card to the workflow's OWN hold column", async () => {
    const deps = createResolvingDeps(
      makeTask({ column: "backlog", status: "awaiting-approval" }),
      renamedIr,
    );

    await approvePlan({ taskId: "FN-1" }, deps as never);

    expect(deps.moveTask).toHaveBeenCalledWith("FN-1", "backlog");
  });

  it("REFUSES a card in a legacy-named column the workflow assigns to REVIEW", async () => {
    /*
    The aliasing case. Unscoped, `todo` counted as a planning lane and startWork would
    have pulled a card out of review and into wip — skipping the review entirely.
    */
    const deps = createResolvingDeps(makeTask({ column: "todo", status: null }), todoIsReviewIr);

    await expectInputError(startWork({ taskId: "FN-1" }, deps as never), 409);
    expect(deps.moveTask).not.toHaveBeenCalled();
  });

  it("still accepts a legacy id the workflow does not use at all (migration window)", async () => {
    // `renamedIr` declares no `todo`, so a pre-U11 row resting there is an orphan and
    // still means "planning".
    const deps = createResolvingDeps(makeTask({ column: "todo", status: null }), renamedIr);

    await expect(startWork({ taskId: "FN-1" }, deps as never)).resolves.toBeTruthy();
    expect(deps.moveTask).toHaveBeenCalledWith("FN-1", "building");
  });
});

/*
FNXC:PluginLifecycleColumns 2026-07-30-07:20 (PR #2607 review, second P1 — greptile):

TWO THINGS THE ROLE-ONLY VERSION GOT WRONG, both of which I had written down as
limitations rather than fixed. Recording a gap you can close is just a nicer way of
leaving it open.

  1. A DECLARED COLUMN IS DECLARED EVEN WHEN IT CARRIES NO ROLE. Building the
     declared set from the six resolved roles left a trait-less column named `todo`
     invisible, so the legacy acceptance claimed it as a planning lane and `startWork`
     would pull a card out of it. The IR lists its own columns; read that instead.

  2. A MISSING ROLE IS NOT A LICENCE TO INVENT A COLUMN. `destination` fell back to
     `todo`/`in-progress` unconditionally, so a valid workflow that simply omits the
     role had `moveTask` called with a column that does not exist on that board. An
     action with nowhere legitimate to send the card is not configured for this
     workflow; 409 says that, a move to a phantom column does not.
*/
/** A column named with a legacy id but carrying NO lifecycle trait. Legal, and not planning. */
const inertTodoIr = {
  version: "v2", id: "wf-custom", name: "inert-todo", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "todo", name: "Parking", traits: [] },
    { id: "building", name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", name: "Done", traits: [{ trait: "complete" }] },
  ],
};

/** A workflow with NO wip lane at all — nowhere for `startWork` to legitimately send a card. */
const noWipIr = {
  version: "v2", id: "wf-custom", name: "no-wip", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "shipped", name: "Done", traits: [{ trait: "complete" }] },
  ],
};

describe("a declared column is declared even when it carries no role", () => {
  it("refuses start-work on an inert column named `todo`", async () => {
    // Pre-fix: `todo` was absent from the role-derived set, the legacy acceptance
    // applied, and the card was pulled out of the operator's parking column.
    const deps = createResolvingDeps(makeTask({ id: "FN-1", column: "todo", status: null }), inertTodoIr);

    await expect(startWork({ taskId: "FN-1" }, deps as never)).rejects.toThrow(/not allowed/);
    expect(deps.moveTask).not.toHaveBeenCalled();
  });

  it("still admits the workflow's REAL planning column", async () => {
    // The other half of the pair: "never a planning lane" must not be able to pass
    // for "reads the IR".
    const deps = createResolvingDeps(makeTask({ id: "FN-2", column: "backlog", status: null }), inertTodoIr);

    await startWork({ taskId: "FN-2" }, deps as never);

    expect(deps.moveTask).toHaveBeenCalledWith("FN-2", "building");
  });
});

describe("a missing destination role conflicts instead of inventing a column", () => {
  it("refuses start-work when the workflow declares no wip lane", async () => {
    // Pre-fix: moved to the literal `in-progress`, which this workflow does not declare.
    const deps = createResolvingDeps(makeTask({ id: "FN-3", column: "backlog", status: null }), noWipIr);

    await expect(startWork({ taskId: "FN-3" }, deps as never)).rejects.toThrow(/not allowed/);
    expect(deps.moveTask).not.toHaveBeenCalled();
  });

  it("refuses approve-plan when the workflow declares no hold lane", async () => {
    const holdlessIr = {
      version: "v2", id: "wf-custom", name: "no-hold", nodes: [], edges: [],
      columns: [
        { id: "backlog", name: "Planning", traits: [{ trait: "intake" }] },
        { id: "building", name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "shipped", name: "Done", traits: [{ trait: "complete" }] },
      ],
    };
    const deps = createResolvingDeps(makeTask({ id: "FN-4", column: "backlog", status: "awaiting-approval" }), holdlessIr);

    await expect(approvePlan({ taskId: "FN-4" }, deps as never)).rejects.toThrow(/not allowed/);
    expect(deps.moveTask).not.toHaveBeenCalled();
  });

  it("STILL uses the legacy id when the workflow genuinely declares it (migration window)", async () => {
    // The fallback is not deleted, it is scoped: a pre-U11 board really does have
    // `todo`, and refusing there would break the migration this program is mid-way
    // through. `todo` here carries the hold trait, so it is a real destination.
    const migrationIr = {
      version: "v2", id: "wf-custom", name: "pre-u11", nodes: [], edges: [],
      columns: [
        { id: "triage", name: "Triage", traits: [{ trait: "intake" }] },
        { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "in-progress", name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      ],
    };
    const deps = createResolvingDeps(makeTask({ id: "FN-5", column: "triage", status: "awaiting-approval" }), migrationIr);

    await approvePlan({ taskId: "FN-5" }, deps as never);

    expect(deps.moveTask).toHaveBeenCalledWith("FN-5", "todo");
  });
});
