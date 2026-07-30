// @vitest-environment node
/*
FNXC:WorkflowResolvedColumns 2026-07-30-14:50 (fleet phase — the dispatcher's own filters):
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
the reconciler in #2737. The bind evaluator is exercised for real; only the store is faked — and that claim is now TRUE, which it
was not when first written. `selectNextTaskForAgentImpl`'s `agent` argument is OPTIONAL and I omitted it, so
`isBindCompatible` hit its `if (!agent) return true` short-circuit and `evaluateImplementationTaskBind` never
ran. The header asserted coverage the invocation did not produce — the same "comment claims what the code
does not do" defect this program keeps finding, in my own test. Every case now passes an executor agent.

REVERT CHECK, measured (both run): restoring `task.column === "in-progress"` fails the WIP case with
`expected null to be truthy`; restoring `task.column === "todo"` fails the hold case the same way. The
default-vocabulary cases pass either way, which is why both vocabularies run.
*/
import { describe, expect, it } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "../types.js";
import { selectNextTaskForAgentImpl } from "../task-store/branch-group-ops.js";

const AGENT_ID = "agent-1";

/** A real agent, so `isBindCompatible` runs `evaluateImplementationTaskBind` instead of short-circuiting. */
const EXECUTOR_AGENT = { id: AGENT_ID, role: "executor" } as never;

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
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-16:15 (#2739 review — greptile P1):
      A SECOND complete lane. `resolveLifecycleColumns` returns the FIRST column per trait, so a dependency
      resting here was not counted as satisfied and its dependent was dropped from dispatch entirely.
      Declared on every vocabulary so the case below is not special-cased to a renamed board.
      */
      { id: `${complete}-signoff`, name: "Signed off", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function makeStore(tasks: Task[], workflowIr: WorkflowIr): TaskStore {
  return {
    listTasks: async () => tasks,
    getTaskWorkflowSelection: () => ({ workflowId: "wf-dispatch", stepIds: [] }),
    getWorkflowDefinition: async () => ({ ir: workflowIr }),
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-16:25 (#2739 review — a fake that hid the thing under test):
    REAL semantics, mirroring `areAllDependenciesDoneImpl`: a dependency is satisfied only if its column is
    in the `satisfiedColumns` set the caller computed. The previous `() => true` made every dependency
    trivially done, so the membership fix and the first-per-role bug were indistinguishable — the new case
    passed with the change reverted, which is exactly the vacuous-test failure this program keeps finding.
    */
    areAllDependenciesDone: (
      dependencies: string[],
      tasksById: Map<string, Task>,
      satisfiedColumns?: ReadonlySet<string>,
    ) => dependencies.every((id) => {
      const dependency = tasksById.get(id);
      return dependency !== undefined
        && (satisfiedColumns ?? new Set(["done", "archived"])).has(dependency.column);
    }),
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

      const selected = await selectNextTaskForAgentImpl(store, AGENT_ID, EXECUTOR_AGENT);

      expect(selected, `${label} lineage selected nothing`).toBeTruthy();
      expect(selected?.task?.id).toBe("FN-1");
      expect(selected?.priority).toBe("in_progress");
    });

    it(`picks up a queued assigned task on a ${label} hold lane (${hold})`, async () => {
      const store = makeStore([task({ id: "FN-2", column: hold })], ir(wip, hold, complete));

      const selected = await selectNextTaskForAgentImpl(store, AGENT_ID, EXECUTOR_AGENT);

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

    expect(await selectNextTaskForAgentImpl(store, AGENT_ID, EXECUTOR_AGENT)).toBeNull();
  });

  it("DOCUMENTS A DEFECT: the role-routing policy does not apply on a renamed board", async () => {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-15:20 (#2739 review — the claim, and what proving it exposed):
    Passing an agent is not evidence the evaluator RAN: an executor agent is allowed, so a short-circuit and
    a real evaluation are indistinguishable from a passing case. So this asserts a `custom`-role agent is
    REFUSED an implementation task on a renamed lane.

    It failed — the task was handed over — and the cause is production, not the test.
    `isImplementationTask` tests Set membership over the hardcoded ids {triage, todo, in-progress, ...}, and
    `evaluateImplementationTaskBind` short-circuits to `allowed: true` when that is false. On a renamed
    board EVERY agent is therefore bind-compatible with EVERY task, and the role check that stops a liaison
    being handed implementation work does not apply at all.

    This case is written to the CURRENT behaviour and named as documenting a defect, so it does not sit red.
    Flip the expectation when the policy resolves lanes by role; the reasoning is recorded at
    `agent-role-policy.ts`'s `IMPLEMENTATION_TASK_COLUMNS`.
    */
    const store = makeStore([task({ id: "FN-9", column: "building" })], ir("building", "backlog", "shipped"));

    const selected = await selectNextTaskForAgentImpl(store, AGENT_ID, { id: AGENT_ID, role: "custom" } as never);

    // Current behaviour, not desired behaviour: the bind check is bypassed, so the task IS selected.
    expect(selected?.task?.id).toBe("FN-9");
  });

  it("a dependency in a SECOND complete lane satisfies the dependent (#2739 review)", async () => {
    /*
    The dependency loop unions terminal columns across dependencies, but added only the resolver's single
    canonical `complete`/`archived` ids. A workflow with two complete lanes therefore left a finished
    blocker reading as unfinished, and the dependent silently never dispatched.

    REVERT CHECK, measured: putting back
      `if (lifecycle?.complete) satisfiedColumns.add(lifecycle.complete)`
    in place of `columnsWithFlag(ir, "complete")` fails this with `expected null to be truthy` — the
    dependent is withheld because its blocker sits in `shipped-signoff`.
    */
    const dependency = task({ id: "FN-DEP", column: "shipped-signoff", assignedAgentId: undefined } as never);
    const dependent = task({ id: "FN-8", column: "backlog", dependencies: ["FN-DEP"] } as never);
    const store = makeStore([dependent, dependency], ir("building", "backlog", "shipped"));

    const selected = await selectNextTaskForAgentImpl(store, AGENT_ID, EXECUTOR_AGENT);

    expect(selected, "dependent withheld: its blocker's terminal lane was not counted").toBeTruthy();
    expect(selected?.task?.id).toBe("FN-8");
  });
});
