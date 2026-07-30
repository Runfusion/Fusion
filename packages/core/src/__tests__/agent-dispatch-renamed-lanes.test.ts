// @vitest-environment node
/*
FNXC:WorkflowResolvedColumns 2026-07-31-06:00 (fleet phase — the dispatcher's own filters):
`selectNextTaskForAgentImpl` picks an agent's next task by filtering the board for its WIP lane, then its
hold lane. Both were `task.column === "<literal>"`.

THE FAILURE: on a board whose lanes are renamed, both filters match nothing, so an agent asking for work
is told there is none — with its own assigned tasks sitting right there in the list it just fetched. No
error, no log line. The agent simply idles.

`agent-heartbeat-worktree-renamed-hold.test.ts` covers the requeue TARGET on a renamed board; nothing
covered the dispatcher's SELECTION filters, which is why this file exists rather than a case added there.

WHY THE IMPL DIRECTLY. The existing `selectNextTaskForAgent` coverage in
`agent-store-routing-policy.test.ts` drives a real store harness, so exercising a renamed vocabulary there
means registering a real custom workflow and moving cards through it. This test is about which lane the
filters name, so it calls the impl with a store fake that resolves a renamed IR — the same shape used for
the reconciler in #2737. The bind evaluator is exercised for real; only the store is faked.

REVERT CHECK, measured (both run): restoring `task.column === "in-progress"` fails the WIP case with
`expected null to be truthy`; restoring `task.column === "todo"` fails the hold case the same way. The
default-vocabulary cases pass either way, which is why both vocabularies run.
*/
import { describe, expect, it } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "../types.js";
import { selectNextTaskForAgentImpl } from "../task-store/branch-group-ops.js";

const AGENT_ID = "agent-1";

/** One workflow shape, two vocabularies — only the column ids differ. */
function ir(wip: string, hold: string, complete: string): WorkflowIr {
  return {
    version: "v2",
    id: "wf-dispatch",
    name: "dispatch",
    nodes: [],
    edges: [],
    columns: [
      { id: hold, name: "Hold", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: wip, name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: complete, name: "Complete", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function makeStore(tasks: Task[], workflowIr: WorkflowIr): TaskStore {
  return {
    listTasks: async () => tasks,
    getTaskWorkflowSelection: () => ({ workflowId: "wf-dispatch", stepIds: [] }),
    getWorkflowDefinition: async () => ({ ir: workflowIr }),
    // Every dependency list in this file is empty, so "all done" is the honest answer.
    areAllDependenciesDone: () => true,
  } as unknown as TaskStore;
}

function task(overrides: Partial<Task> & { id: string; column: string }): Task {
  return {
    title: overrides.id,
    description: "work",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    assignedAgentId: AGENT_ID,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    columnMovedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  } as unknown as Task;
}

const LINEAGES = [
  { label: "DEFAULT", wip: "in-progress", hold: "todo", complete: "done" },
  { label: "RENAMED", wip: "building", hold: "backlog", complete: "shipped" },
] as const;

describe("agent dispatch selects by lifecycle ROLE, not by column id", () => {
  for (const { label, wip, hold, complete } of LINEAGES) {
    it(`resumes an in-progress assigned task on a ${label} WIP lane (${wip})`, async () => {
      const store = makeStore([task({ id: "FN-1", column: wip })], ir(wip, hold, complete));

      const selected = await selectNextTaskForAgentImpl(store, AGENT_ID);

      expect(selected, `${label} lineage selected nothing`).toBeTruthy();
      expect(selected?.task?.id).toBe("FN-1");
      expect(selected?.priority).toBe("in_progress");
    });

    it(`picks up a queued assigned task on a ${label} hold lane (${hold})`, async () => {
      const store = makeStore([task({ id: "FN-2", column: hold })], ir(wip, hold, complete));

      const selected = await selectNextTaskForAgentImpl(store, AGENT_ID);

      expect(selected, `${label} lineage selected nothing`).toBeTruthy();
      expect(selected?.task?.id).toBe("FN-2");
    });
  }

  it("still skips an operator-parked hold task on a renamed board", async () => {
    /*
    Non-vacuous guard on the hold filter: it must keep its `userPaused` exclusion, not just its lane.
    Without this, a filter that matched every column would satisfy both cases above.
    */
    const store = makeStore(
      [task({ id: "FN-3", column: "backlog", userPaused: true } as never)],
      ir("building", "backlog", "shipped"),
    );

    expect(await selectNextTaskForAgentImpl(store, AGENT_ID)).toBeNull();
  });
});
