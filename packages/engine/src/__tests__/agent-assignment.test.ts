import type { Agent, Task } from "@fusion/core";
import { describe, expect, it } from "vitest";
import { listEligibleExecutorAgents, selectPermanentAgentForTask } from "../agent-assignment.js";

function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    name: overrides.name ?? overrides.id,
    role: overrides.role ?? "executor",
    state: overrides.state ?? "idle",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? "",
    column: overrides.column ?? "todo",
    priority: overrides.priority ?? "normal",
    dependencies: overrides.dependencies ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    log: overrides.log ?? [],
    ...overrides,
  } as Task;
}

describe("selectPermanentAgentForTask", () => {
  it("returns null when no eligible permanent executor exists", async () => {
    const agent = makeAgent({ id: "ephemeral-1", metadata: { agentKind: "task-worker" } });
    const selected = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-1" }),
      agentStore: {
        listAgents: async () => [agent],
        getChainOfCommand: async () => [],
      } as never,
      taskStore: { listTasks: async () => [] } as never,
    });

    expect(selected).toBeNull();
  });

  it("filters out ephemeral, disabled, errored, and non-executor agents", async () => {
    const selected = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-2" }),
      agentStore: {
        listAgents: async () => [
          makeAgent({ id: "ephemeral", metadata: { agentKind: "task-worker" } }),
          makeAgent({ id: "disabled", runtimeConfig: { enabled: false } }),
          makeAgent({ id: "errored", state: "error" }),
          makeAgent({ id: "reviewer", role: "reviewer" }),
          makeAgent({ id: "ok", createdAt: "2026-01-01T00:00:01.000Z" }),
        ],
        getChainOfCommand: async () => [],
      } as never,
      taskStore: { listTasks: async () => [] } as never,
    });

    expect(selected?.id).toBe("ok");
  });

  it("selects least-loaded agent", async () => {
    const selected = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-3" }),
      agentStore: {
        listAgents: async () => [
          makeAgent({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
          makeAgent({ id: "b", createdAt: "2026-01-01T00:00:01.000Z" }),
        ],
        getChainOfCommand: async () => [],
      } as never,
      taskStore: {
        listTasks: async () => [
          makeTask({ id: "T1", column: "in-progress", assignedAgentId: "a" }),
          makeTask({ id: "T2", column: "todo", assignedAgentId: "a" }),
          makeTask({ id: "T3", column: "in-review", assignedAgentId: "b" }),
          makeTask({ id: "T4", column: "done", assignedAgentId: "b" }),
        ],
      } as never,
    });

    expect(selected?.id).toBe("b");
  });

  it("uses createdAt then id for deterministic tie-break", async () => {
    const selectedByCreatedAt = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-4" }),
      agentStore: {
        listAgents: async () => [
          makeAgent({ id: "b", createdAt: "2026-01-02T00:00:00.000Z" }),
          makeAgent({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
        ],
        getChainOfCommand: async () => [],
      } as never,
      taskStore: { listTasks: async () => [] } as never,
    });
    expect(selectedByCreatedAt?.id).toBe("a");

    const selectedById = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-5" }),
      agentStore: {
        listAgents: async () => [
          makeAgent({ id: "b", createdAt: "2026-01-01T00:00:00.000Z" }),
          makeAgent({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
        ],
        getChainOfCommand: async () => [],
      } as never,
      taskStore: { listTasks: async () => [] } as never,
    });
    expect(selectedById?.id).toBe("a");
  });

  it("prefers agents in reporting chain of mission/slice-linked assignees", async () => {
    const selected = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-6", missionId: "M-1", sliceId: "SL-1" }),
      agentStore: {
        listAgents: async () => [
          makeAgent({ id: "agent-a", createdAt: "2026-01-01T00:00:00.000Z" }),
          makeAgent({ id: "agent-b", createdAt: "2026-01-01T00:00:00.000Z" }),
          makeAgent({ id: "agent-c", createdAt: "2026-01-01T00:00:00.000Z" }),
        ],
        getChainOfCommand: async (agentId: string) => (agentId === "agent-c" ? [makeAgent({ id: "agent-b" })] : []),
      } as never,
      taskStore: {
        listTasks: async () => [
          makeTask({ id: "FN-linked", missionId: "M-1", sliceId: "SL-1", assignedAgentId: "agent-c", column: "todo" }),
          makeTask({ id: "FN-other", missionId: "M-2", assignedAgentId: "agent-a", column: "todo" }),
        ],
      } as never,
    });

    expect(["agent-b", "agent-c"]).toContain(selected?.id);
    expect(selected?.id).toBe("agent-b");
  });
});

describe("listEligibleExecutorAgents", () => {
  it("returns empty when only custom-role (catalog-imported) agents exist", async () => {
    const eligible = await listEligibleExecutorAgents({
      listAgents: async () => [
        makeAgent({ id: "gstack-1", role: "custom" }),
        makeAgent({ id: "gstack-2", role: "custom" }),
      ],
    } as never);

    expect(eligible).toEqual([]);
  });

  it("excludes ephemeral, disabled, and errored executors but keeps healthy ones", async () => {
    const eligible = await listEligibleExecutorAgents({
      listAgents: async () => [
        makeAgent({ id: "ephemeral", metadata: { agentKind: "task-worker" } }),
        makeAgent({ id: "disabled", runtimeConfig: { enabled: false } }),
        makeAgent({ id: "errored", state: "error" }),
        makeAgent({ id: "reviewer", role: "reviewer" }),
        makeAgent({ id: "ok" }),
      ],
    } as never);

    expect(eligible.map((agent) => agent.id)).toEqual(["ok"]);
  });

  /*
  FNXC:AgentRouting 2026-07-12-13:20:
  Issue #2015 regression: an executor-ROLE liaison agent must be excludable from the scheduler's auto-assign
  pool via runtimeConfig.assignmentPolicy — this pool was the routing path that bound NEXT-871 to the liaison.
  */
  it("excludes executors with assignmentPolicy 'explicit-only' or 'none' from the auto-assign pool", async () => {
    const eligible = await listEligibleExecutorAgents({
      listAgents: async () => [
        makeAgent({ id: "liaison-none", runtimeConfig: { assignmentPolicy: "none" } }),
        makeAgent({ id: "explicit-only", runtimeConfig: { assignmentPolicy: "explicit-only" } }),
        makeAgent({ id: "auto-explicitly", runtimeConfig: { assignmentPolicy: "auto" } }),
        makeAgent({ id: "auto-default" }),
      ],
    } as never);

    expect(eligible.map((agent) => agent.id)).toEqual(["auto-explicitly", "auto-default"]);
  });

  it("never auto-assigns a task to a policy-excluded executor even when it is the only agent", async () => {
    const selected = await selectPermanentAgentForTask({
      task: makeTask({ id: "NEXT-871" }),
      agentStore: {
        listAgents: async () => [
          makeAgent({ id: "liaison", runtimeConfig: { assignmentPolicy: "none" } }),
        ],
        getChainOfCommand: async () => [],
      } as never,
      taskStore: { listTasks: async () => [] } as never,
    });

    expect(selected).toBeNull();
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-05:40 (batch-engine feed):

THE INVARIANT: assignment load counts the cards a board's OWN lanes call active.

CENSUS-INVISIBLE. The gate was a `Set` literal — a definition, not a comparison — so no lifecycle
backlog entry ever pointed at this file. Found by grepping for lane-shaped list literals after the
same shape turned up in `duplicate-intake` and `blocker-fanout`.

The failure is a silent DEGRADATION rather than an error, and it is invisible in exactly the way that
matters: on a renamed board no column matched, so `assignmentLoad` stayed empty, every candidate
compared as load 0, and the sort fell through to its stable `createdAt` tiebreak. The SAME agent then
wins every assignment while the rest sit idle. Nothing logs and nothing fails — the board simply
distributes badly, which reads as an agent being "busy" rather than as a bug.

REVERT PROOF, measured: restore the hard-coded Set and the renamed case fails — the loaded agent is
picked instead of the idle one, because its load reads as 0.
*/
describe("assignment load resolves the board's own active lanes", () => {
  const agents = [
    makeAgent({ id: "AG-BUSY", createdAt: "2026-01-01T00:00:00.000Z" }),
    makeAgent({ id: "AG-IDLE", createdAt: "2026-01-02T00:00:00.000Z" }),
  ];

  const store = (columnOfBusyWork: string) => ({
    listTasks: async () => [
      makeTask({ id: "FN-EXISTING", assignedAgentId: "AG-BUSY", column: columnOfBusyWork } as never),
    ],
  }) as never;

  const select = (columnOfBusyWork: string, activeColumns?: ReadonlySet<string>) =>
    selectPermanentAgentForTask({
      task: makeTask({ id: "FN-NEW" }),
      agentStore: { listAgents: async () => agents, getChainOfCommand: async () => [] } as never,
      taskStore: store(columnOfBusyWork),
      /*
      #2787 review, third round: the option is now a PER-TASK predicate rather than a board-wide set,
      because a project runs several workflows and a column id means something only relative to its
      own. The tests keep expressing intent as a set and adapt it here.
      */
      ...(activeColumns ? { countsAsAssignmentLoad: (t: { column: string }) => activeColumns.has(t.column) } : {}),
    });

  it("prefers the idle agent when the busy one's work sits in a RENAMED wip lane", async () => {
    // Pre-fix: `building` matched no literal, AG-BUSY read as load 0, and its earlier createdAt won.
    const selected = await select("building", new Set(["backlog", "building", "signoff"]));

    expect(selected?.id).toBe("AG-IDLE");
  });

  it("keeps the legacy trio when no lanes are supplied", async () => {
    const selected = await select("in-progress");

    expect(selected?.id).toBe("AG-IDLE");
  });

  it("counts work parked in a RENAMED hold lane, as the legacy set counted todo", async () => {
    /*
    #2787 review, second round (greptile P1). The legacy set is `{todo, in-progress, in-review}` and
    `todo` is the HOLD lane, so a resolved set covering only wip and review DROPS assigned backlog
    work from the tally — a regression against legacy introduced by the argument meant to fix the
    renamed case. The resolved answer must cover every role the literal covered.
    */
    const selected = await select("backlog", new Set(["backlog", "building", "signoff"]));

    expect(selected?.id).toBe("AG-IDLE");
  });

  it("does not count work parked outside the supplied lanes", async () => {
    // A finished card must not hold load against its agent, or the agent looks busy forever.
    const selected = await select("shipped", new Set(["backlog", "building", "signoff"]));

    expect(selected?.id).toBe("AG-BUSY");
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-11:40 (#2787 review — greptile P1, third round):

THE INVARIANT: load is counted per task, against the task's OWN workflow.

My first wiring resolved lanes from the CANDIDATE task's workflow and applied that flat set to every
assigned row. On a project running several workflows — the normal case, not an exotic one —
assignments in another workflow's load-bearing lanes vanished from the tally, and the
already-loaded-agent-wins bug returned through a different door.

A column id means something only RELATIVE TO ITS OWN WORKFLOW. `blocker-fanout.ts` states this and
offers a per-task `classify`; the option is now the same shape rather than a third invention.

REVERT PROOF, measured: answer the predicate from one workflow's lanes for every row (the flat-set
shape) and the cross-workflow case below picks the loaded agent.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-30-12:25 (#2796 review — greptile):

THE PREDICATE MUST SEE THE HELPER'S OWN ROWS, NOT A CALLER'S EARLIER SNAPSHOT.

The scheduler built a Set of load-bearing task IDs from its own `listTasks` read, and this helper
then applied the predicate to rows from ITS read. Anything changing in between diverged in both
directions: a task MOVED out of a load-bearing lane kept its id in the set and still counted, while a
task created or newly assigned in between was missing and counted as zero.

The fix memoises the resolved LANES per task and tests them against `candidate.column`, so the verdict
comes from the row the helper actually holds. That only works if the helper passes its own live rows
to the predicate — this pins that contract. If the helper ever pre-resolved or cached rows, the
scheduler's fix would silently go back to answering about a board that no longer exists.

It is a contract test, not an end-to-end reproduction: the race lives in a dispatch path this suite
cannot stand up, and the existing `scheduler-load-lane-union` test says the same of its own call site.
*/
describe("countsAsAssignmentLoad is called with the helper's own task rows", () => {
  it("passes the live column, so a caller keyed on a stale snapshot cannot win", async () => {
    const agents = [
      makeAgent({ id: "AG-A", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeAgent({ id: "AG-B", createdAt: "2026-01-02T00:00:00.000Z" }),
    ];
    /*
    The helper's snapshot: FN-MOVED has already left the load-bearing lane and sits in `shipped`.
    A caller that decided "FN-MOVED bears load" from an earlier read must not be able to impose that.
    */
    const taskStore = {
      listTasks: async () => [
        makeTask({ id: "FN-MOVED", assignedAgentId: "AG-A", column: "shipped" } as never),
      ],
    } as never;

    const seen: Array<{ id: string; column: string }> = [];
    const selected = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-NEW" }),
      agentStore: { listAgents: async () => agents, getChainOfCommand: async () => [] } as never,
      taskStore,
      countsAsAssignmentLoad: (t: { id: string; column: string }) => {
        seen.push({ id: t.id, column: t.column });
        /* The shape the scheduler now uses: resolved lanes for this task, tested against its LIVE column. */
        return new Set(["backlog", "building", "signoff"]).has(t.column);
      },
    });

    /* The predicate saw the helper's row, with the column as it is NOW. */
    expect(seen).toEqual([{ id: "FN-MOVED", column: "shipped" }]);
    /* And therefore AG-A carries no load, so the older agent wins on the tiebreaker. */
    expect(selected?.id).toBe("AG-A");
  });
});

describe("assignment load is counted per task, across workflows", () => {
  it("counts an assignment held in ANOTHER workflow's wip lane", async () => {
    const agents = [
      makeAgent({ id: "AG-BUSY", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeAgent({ id: "AG-IDLE", createdAt: "2026-01-02T00:00:00.000Z" }),
    ];
    // The new card's board calls its wip lane `building`; the busy agent's existing work sits in a
    // DIFFERENT workflow whose wip lane is `implementing`.
    const taskStore = {
      listTasks: async () => [
        makeTask({ id: "FN-OTHER-WF", assignedAgentId: "AG-BUSY", column: "implementing" } as never),
      ],
    } as never;

    const selected = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-NEW" }),
      agentStore: { listAgents: async () => agents, getChainOfCommand: async () => [] } as never,
      taskStore,
      // Per-task: each row answered against its own workflow's lanes.
      countsAsAssignmentLoad: (t: { column: string }) =>
        ["backlog", "building", "signoff"].includes(t.column) || ["queued", "implementing"].includes(t.column),
    });

    expect(selected?.id).toBe("AG-IDLE");
  });
});
