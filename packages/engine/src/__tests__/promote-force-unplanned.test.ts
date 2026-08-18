/*
FNXC:WorkflowScheduling 2026-07-25-04:55:
Force-promote past the `unplanned-for-execution` gate (the rejection an
FN-8471-style pending replan / pre-release Plan Review raises). The invariant
under test is scoped: `force` waives the PLAN gate and nothing else, and only on
an explicit promote request. Surfaces enumerated here — unforced promote (still
rejects), forced promote (releases + clears the durable replan signal), forced
promote into a full column (still capacity-rejected), forced promote of a card
that is not held (still rejected), the automatic event release (has no `force`
parameter at all, so FN-7648 still holds for automatic releases), and the
agent-native `fn_task_promote` tool (same two outcomes through the tool surface).
*/
import { describe, expect, it, vi } from "vitest";
/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2):
These call-arg assertions now include the mutation context the converted sweep passes.
Adding it is what keeps them load-bearing: left at the old arity every
`toHaveBeenCalledWith` here would fail, and every `.not.toHaveBeenCalledWith` would pass
vacuously — an assertion that can no longer fail is worse than one that is red.
*/
import { UNATTRIBUTED_MUTATION_CONTEXT } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import { promoteHeldTask, releaseHeldTaskByEvent } from "../execution/hold-release.js";
import { createTaskPromoteTool } from "../agent-tools.js";

function workflow(): WorkflowIr {
  return {
    version: "v2",
    name: "force-promote",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [{ from: "start", to: "end" }],
  };
}

/** A store whose task is parked in the durable replan signal — i.e. unplanned. */
function makeStore(overrides: Record<string, unknown> = {}) {
  const task = { id: "FN-1403", column: "todo", status: "needs-replan" } as Record<string, unknown>;
  const moveTaskIf = vi.fn(async () => ({ moved: true }));
  const updateTask = vi.fn(async (_id: string, updates: Record<string, unknown>) => {
    Object.assign(task, updates);
    return task;
  });
  const recordRunAuditEvent = vi.fn(async () => ({}));
  const store = {
    task,
    getTask: async () => task,
    updateTask,
    moveTaskIf,
    recordRunAuditEvent,
    getTaskWorkflowSelection: () => ({ workflowId: "custom", stepIds: [] }),
    getWorkflowDefinition: async () => ({ ir: workflow() }),
    ...overrides,
  };
  return store as typeof store & Record<string, unknown>;
}

describe("force-promote past the unplanned-for-execution gate", () => {
  it("rejects an unplanned card when force is not requested", async () => {
    const store = makeStore();
    const result = await promoteHeldTask(store as never, "FN-1403");

    expect(result).toMatchObject({ released: false, rejection: "unplanned-for-execution", toColumn: "in-progress" });
    expect(store.moveTaskIf).not.toHaveBeenCalled();
    expect(store.task.status).toBe("needs-replan");
  });

  it("releases into execution and clears the replan signal when forced", async () => {
    const store = makeStore();
    const result = await promoteHeldTask(store as never, "FN-1403", {}, { force: true });

    expect(result).toMatchObject({ released: true, toColumn: "in-progress", forcedUnplanned: true });
    expect(store.moveTaskIf).toHaveBeenCalledTimes(1);
    // The replan signal must be gone, or triage rediscovery pulls the card back
    // into the very replan the operator just waived.
    expect(store.updateTask).toHaveBeenCalledWith("FN-1403", { status: null }, UNATTRIBUTED_MUTATION_CONTEXT);
    expect(store.task.status).toBeNull();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:promote-forced-unplanned", taskId: "FN-1403" }),
    );
  });

  it("still enforces capacity when forced — force waives only the plan gate", async () => {
    const store = makeStore();
    const reserveSlot = vi.fn(async () => null);

    const result = await promoteHeldTask(store as never, "FN-1403", { reserveSlot }, { force: true });

    expect(result).toMatchObject({ released: false, rejection: "capacity-exhausted-or-no-slot" });
    expect(reserveSlot).toHaveBeenCalledTimes(1);
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  it("still enforces hold membership when forced", async () => {
    const store = makeStore({
      getTask: async () => ({ id: "FN-1403", column: "in-progress", status: "needs-replan" }),
    });

    const result = await promoteHeldTask(store as never, "FN-1403", {}, { force: true });

    expect(result).toMatchObject({ released: false, rejection: "not-held" });
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  it("does not leak the override to the automatic event-release surface", async () => {
    const store = makeStore({
      getTask: async () => ({
        id: "FN-1403",
        column: "todo",
        status: "needs-replan",
        // event releases only act on external-event holds; use one so the
        // release actually reaches the unplanned guard rather than short-circuiting.
      }),
      getWorkflowDefinition: async () => ({
        ir: {
          ...workflow(),
          columns: [
            { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "external-event" } }] },
            { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
            { id: "done", name: "Done", traits: [{ trait: "complete" }] },
          ],
        } as WorkflowIr,
      }),
    });

    const result = await releaseHeldTaskByEvent(store as never, "FN-1403", "webhook");

    expect(result.released).toBe(false);
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });
});

describe("fn_task_promote force parity", () => {
  it("rejects without force and names the flag so the caller can decide", async () => {
    const store = makeStore();
    const tool = createTaskPromoteTool(store as never, "FN-1403");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute("call-1", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unplanned-for-execution");
    expect(result.content[0].text).toContain("force:true");
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  it("releases with force and reports that the replan was waived", async () => {
    const store = makeStore();
    const tool = createTaskPromoteTool(store as never, "FN-1403");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute("call-2", { force: true });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("in-progress");
    expect(result.content[0].text).toContain("replan was cancelled");
    expect(result.details).toMatchObject({ released: true, forcedUnplanned: true });
    expect(store.moveTaskIf).toHaveBeenCalledTimes(1);
    expect(store.task.status).toBeNull();
  });
});
