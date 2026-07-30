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
