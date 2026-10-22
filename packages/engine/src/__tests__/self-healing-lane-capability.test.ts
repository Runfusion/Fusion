import { describe, expect, it, vi } from "vitest";
import { LANE_CAPABILITY_DECLINE_CODE, type Agent, type Task } from "@fusion/core";
import { reconcileLaneCapabilityMisbinds } from "../self-healing/lane-capability-reconciliation.js";

/*
FNXC:LaneCapabilityReconciliation 2026-09-26-19:40 (RUFU-272 Step 4):
In-process coverage for the sweep that is the SOLE mutation owner of the lane-capability repair.
The fake stores expose exactly the seams the sweep calls: the task side (slim list + getTask +
updateTask + workflow-selection resolution + audit sink) and the lane side (listAgents/getAgent).
The default workflow selection (null) resolves to the default synthesized lane set
{todo, in-progress, in-review}, so "todo" is implementation-class here exactly as on an
unrenamed board. The durable-mirror half of a rebind is proven PG-backed in
`lane-capability-reconciliation.pg.test.ts`; here the assertion is the single sanctioned write.
*/

type FakeTask = Partial<Task> & Pick<Task, "id" | "column">;

function createFakeTaskStore(tasks: FakeTask[], settings: Record<string, unknown> = {}) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const auditEvents: Array<{ mutationType: string; metadata?: Record<string, unknown> }> = [];
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const task = byId.get(id);
    if (!task) throw new Error("Task not found");
    Object.assign(task, patch);
    return task;
  });
  const store = {
    auditEvents,
    updateTask,
    getSettings: async () => ({ globalPause: false, enginePaused: false, ...settings }),
    listTasks: async () => [...byId.values()],
    getTask: async (id: string) => byId.get(id) ?? null,
    getTaskWorkflowSelection: async () => null,
    recordRunAuditEvent: async (entry: { mutationType: string; metadata?: Record<string, unknown> }) => {
      auditEvents.push(entry);
    },
  };
  return store as unknown as FakeTaskStoreSurface & typeof store;
}

type FakeTaskStoreSurface = {
  getSettings(): Promise<unknown>;
  listTasks(input?: unknown): Promise<unknown>;
  getTask(id: string): Promise<unknown>;
  updateTask(id: string, patch: unknown): Promise<unknown>;
  getTaskWorkflowSelection(id: string): Promise<unknown>;
};

function createFakeAgentStore(agents: Agent[]) {
  const agentStore = {
    agents,
    listAgents: async () => agents.filter((agent) => !agent.ephemeral),
    getAgent: async (id: string) => agents.find((agent) => agent.id === id) ?? null,
    /** Mirror half of the assignment seam, mutated by hand to stand in for the store. */
    setMirror: (agentId: string, taskId: string | undefined) => {
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (agent) agent.taskId = taskId;
    },
  };
  return agentStore as unknown as FakeAgentStoreSurface & typeof agentStore;
}

type FakeAgentStoreSurface = {
  listAgents(input?: unknown): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | null>;
};

const auditOnlyLane = {
  id: "audit-lane",
  name: "Audit Lane",
  role: "reviewer",
  roles: ["reviewer"],
  state: "idle",
  runtimeConfig: {},
} as unknown as Agent;

const autoExecutorLane = {
  id: "auto-exec",
  name: "Auto Executor",
  role: "executor",
  roles: ["executor"],
  state: "idle",
  runtimeConfig: {},
} as unknown as Agent;

const explicitExecutorLane = {
  id: "explicit-exec",
  name: "Explicit Executor",
  role: "executor",
  roles: ["executor"],
  state: "idle",
  runtimeConfig: { assignmentPolicy: "explicit-only" },
} as unknown as Agent;

function strandedCard(overrides: FakeTask = {}): FakeTask {
  return {
    id: "FN-T1",
    column: "todo",
    status: null,
    assignedAgentId: auditOnlyLane.id,
    paused: false,
    userPaused: false,
    pausedByAgentId: null,
    deletedAt: null,
    branch: "fusion/fn-t1",
    worktree: "/wt/fn-t1",
    sessionFile: "/wt/fn-t1/session.jsonl",
    currentStep: 2,
    ...overrides,
  };
}

const neverLive = () => false;

describe("reconcileLaneCapabilityMisbinds", () => {
  it("rebounds a stranded card from an ineligible durable owner to an eligible auto lane, preserving execution context", async () => {
    const card = strandedCard();
    const store = createFakeTaskStore([card]);
    const agentStore = createFakeAgentStore([auditOnlyLane, autoExecutorLane]);

    const count = await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive);

    expect(count).toBe(1);
    // ONE write, through the sanctioned owner seam only — never a mirror mutation, never a column.
    expect(store.updateTask).toHaveBeenCalledTimes(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-T1", { assignedAgentId: "auto-exec" });
    expect(card.assignedAgentId).toBe("auto-exec");
    expect(card.column).toBe("todo");
    expect(card.branch).toBe("fusion/fn-t1");
    expect(card.worktree).toBe("/wt/fn-t1");
    expect(card.sessionFile).toBe("/wt/fn-t1/session.jsonl");
    expect(card.currentStep).toBe(2);
    expect(store.auditEvents.map((entry) => entry.mutationType)).toContain("task:reconcile-lane-capability-misbind-rebound");
    const rebound = store.auditEvents.find((entry) => entry.mutationType === "task:reconcile-lane-capability-misbind-rebound");
    // ids/counts/outcomes only — no decline prose anywhere in the row.
    expect(rebound?.metadata).toEqual(expect.objectContaining({
      outcome: "rebound",
      taskId: "FN-T1",
      priorAgentId: "audit-lane",
      nextAgentId: "auto-exec",
      column: "todo",
    }));
  });

  it("never touches a card whose durable owner is an explicit-only executor lane (the witness pair)", async () => {
    const card = strandedCard({ assignedAgentId: explicitExecutorLane.id });
    const store = createFakeTaskStore([card]);
    const agentStore = createFakeAgentStore([auditOnlyLane, autoExecutorLane, explicitExecutorLane]);

    const count = await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive);

    expect(count).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(card.assignedAgentId).toBe("explicit-exec");
  });

  it("never touches a card with a live session", async () => {
    const card = strandedCard();
    const store = createFakeTaskStore([card]);
    const agentStore = createFakeAgentStore([auditOnlyLane, autoExecutorLane]);

    const count = await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, (task) => task.id === "FN-T1");

    expect(count).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(card.assignedAgentId).toBe("audit-lane");
  });

  it("never touches a card paused by its own assignee (the auto-unpause hazard)", async () => {
    const card = strandedCard({ paused: true, pausedReason: "agent-paused", pausedByAgentId: auditOnlyLane.id });
    const store = createFakeTaskStore([card]);
    const agentStore = createFakeAgentStore([auditOnlyLane, autoExecutorLane]);

    const count = await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive);

    expect(count).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(card.pausedByAgentId).toBe("audit-lane");
  });

  it("freezes a stranded card exactly once when no eligible lane exists, keeping the named owner", async () => {
    const card = strandedCard();
    const store = createFakeTaskStore([card]);
    const agentStore = createFakeAgentStore([auditOnlyLane]); // no executor/engineer lane at all

    const firstPass = await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive);

    expect(firstPass).toBe(1);
    expect(card.assignedAgentId).toBe("audit-lane"); // freeze keeps the owner — it names the remedy
    expect(card.paused).toBe(true);
    expect(card.pausedReason).toBe("external-block");
    expect(card.externalBlock?.code).toBe(LANE_CAPABILITY_DECLINE_CODE);
    expect(card.externalBlock?.resume?.column).toBe("todo");
    expect(card.externalBlock?.resume?.branch).toBe("fusion/fn-t1");
    expect(store.auditEvents.map((entry) => entry.mutationType)).toContain("task:reconcile-lane-capability-decline-frozen");

    const freezeWrites = store.updateTask.mock.calls.length;
    const secondPass = await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive);
    expect(secondPass).toBe(0);
    expect(store.updateTask).toHaveBeenCalledTimes(freezeWrites); // not re-frozen
  });

  it("is idempotent across consecutive passes after a rebind", async () => {
    const card = strandedCard();
    const store = createFakeTaskStore([card]);
    const agentStore = createFakeAgentStore([auditOnlyLane, autoExecutorLane]);

    expect(await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive)).toBe(1);
    const writesAfterFirst = store.updateTask.mock.calls.length;

    expect(await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive)).toBe(0);
    expect(store.updateTask).toHaveBeenCalledTimes(writesAfterFirst);
    expect(card.assignedAgentId).toBe("auto-exec");
  });

  it("leaves the rebound owner intact through a drift-recovery mirror clear (no ping-pong)", async () => {
    const card = strandedCard();
    const store = createFakeTaskStore([card]);
    const agentStore = createFakeAgentStore([auditOnlyLane, autoExecutorLane]);
    // Pre-existing mirror halves: the audit lane holds the stale link the fake store never moved.
    agentStore.setMirror(auditOnlyLane.id, card.id);

    expect(await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive)).toBe(1);

    // Stand-in for `recoverDriftedAgentTaskLinks`' clearing rule: an agent mirror whose linked
    // card's durable owner moved away is stale and gets cleared. It never writes assignedAgentId,
    // so the repaired owner must survive a drift pass untouched.
    const staleMirrorHolders = agentStore.agents.filter(
      (agent) => agent.taskId && card.assignedAgentId !== agent.id,
    );
    for (const holder of staleMirrorHolders) agentStore.setMirror(holder.id, undefined);

    expect(card.assignedAgentId).toBe("auto-exec");
    expect(auditOnlyLane.taskId).toBeUndefined();
    expect(await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive)).toBe(0);
  });

  it("emits a deduped no-action row when a confirmed candidate is suppressed before the write", async () => {
    // The prescreen/re-read split exists for exactly this race: the slim snapshot says idle+owner
    // intact, the authoritative re-read says a pause landed in between. The candidate is real, the
    // repair aborts, and the pass records one counts-only no-action row.
    const card = strandedCard();
    const store = createFakeTaskStore([card]);
    const agentStore = createFakeAgentStore([auditOnlyLane, autoExecutorLane]);
    let passesBeforePause = 0;
    const realGetTask = store.getTask.bind(store);
    store.getTask = (async (id: string) => {
      const task = await realGetTask(id);
      // 1st read = candidacy (unpaused), 2nd read = pre-write re-assert (pause landed), later
      // reads settle back to the true row so follow-up passes are observable.
      if (id === "FN-T1" && passesBeforePause === 1) Object.assign(task as FakeTask, { paused: true, pausedReason: "agent-paused" });
      passesBeforePause++;
      if (passesBeforePause > 2) Object.assign(task as FakeTask, { paused: false, pausedReason: null });
      return task;
    }) as typeof store.getTask;

    expect(await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive)).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    const noActionRows = store.auditEvents.filter((entry) => entry.mutationType === "task:reconcile-lane-capability-misbind-no-action");
    expect(noActionRows).toHaveLength(1);
    expect(noActionRows[0]?.metadata).toEqual(expect.objectContaining({ outcome: "suppressed", suppressedCount: 1 }));
  });

  it("bails without mutation when the engine or global pause is engaged", async () => {
    const card = strandedCard();
    const store = createFakeTaskStore([card], { enginePaused: true });
    const agentStore = createFakeAgentStore([auditOnlyLane, autoExecutorLane]);

    expect(await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive)).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("skips cards with no durable owner — mirror-only drift belongs to the link sweeps", async () => {
    const card = strandedCard({ assignedAgentId: null });
    const store = createFakeTaskStore([card]);
    const agentStore = createFakeAgentStore([auditOnlyLane, autoExecutorLane]);
    agentStore.setMirror(auditOnlyLane.id, card.id);

    expect(await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive)).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(auditOnlyLane.taskId).toBe("FN-T1"); // untouched — not this sweep's business
  });
});

describe("reconcileLaneCapabilityMisbinds review-lane skip", () => {
  /*
  FNXC:LaneCapabilityReconciliation 2026-10-22-15:56 (RUFU-766):
  The sweep decides with the IMPLEMENTATION verdict, and `in-review` is implementation-class by lane vocabulary on
  purpose. Before RUFU-766 that made a review-lane card owned by its reviewer look like a misbind, so this pass
  either moved the review to an executor lane or froze the card with the sentence telling the operator to grant
  the reviewer the `executor` role. A card sitting in the lane its own workflow declares for review is a routing
  fact, not a capability mismatch — the skip is the narrow review lane, never the broad implementation set.
  */
  it("leaves a review-lane card owned by a reviewer lane completely alone", async () => {
    const card = strandedCard({ id: "KUBE-027", column: "in-review", assignedAgentId: auditOnlyLane.id });
    const store = createFakeTaskStore([card]);
    const agentStore = createFakeAgentStore([auditOnlyLane, autoExecutorLane]);

    const count = await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive);

    expect(count).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(card.assignedAgentId).toBe("audit-lane");
    // No decline freeze written: the freeze's remedy sentence is the implementation one.
    expect(card.status).toBeNull();
    expect(card.paused).toBe(false);
    expect(card.externalBlock).toBeUndefined();
    expect(store.auditEvents.map((entry) => entry.mutationType)).toEqual([]);
  });

  it("still repairs the same owner when the card is NOT in its review lane (the skip is narrow)", async () => {
    const card = strandedCard({ id: "KUBE-184", column: "in-progress", assignedAgentId: auditOnlyLane.id });
    const store = createFakeTaskStore([card]);
    const agentStore = createFakeAgentStore([auditOnlyLane, autoExecutorLane]);

    expect(await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive)).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("KUBE-184", { assignedAgentId: "auto-exec" });
  });

  it("still repairs a review-lane card whose owner is not the review pool at all", async () => {
    // Merge-orchestration-style ownership in a review lane keeps its pre-RUFU-766 behavior: the skip protects a
    // card owned BY the review pool, not every card parked in the lane.
    const card = strandedCard({ id: "KUBE-190", column: "in-review", assignedAgentId: "auto-exec" });
    const store = createFakeTaskStore([card]);
    const reviewerOnlyLane = { ...auditOnlyLane, id: "exec-pool", roles: ["executor"], role: "executor" } as unknown as Agent;
    const agentStore = createFakeAgentStore([autoExecutorLane, reviewerOnlyLane]);

    const count = await reconcileLaneCapabilityMisbinds(store as never, agentStore as never, neverLive);

    // `auto-exec` is an eligible owner for an implementation-class card, so nothing is a misbind here either —
    // the point is the verdict still runs (no blanket skip) and writes nothing it should not.
    expect(count).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
