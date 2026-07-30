/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:50 (the unwired-parameter class, cf. #2803):

`isParkedTaskColumn(task, parkedColumns?)` has taken a RESOLVED lane set since its own conversion, and
`task-agent-sync-renamed-columns.test.ts` proves the seam works when the set is supplied. But BOTH call
sites in `agent-heartbeat.ts` passed nothing and silently took the legacy `todo`/`triage` default, so on
a board whose hold and intake lanes are renamed the check returned false for every card.

A resolved seam nobody wired is indistinguishable from no seam at all — which is why the seam test alone
could not catch this, and why the caller audit (#2803) found five more of the same shape.

CONSEQUENCE. `reconcileOrphanedRunningAgents` clears a durable agent's task link when the card is parked
with no live execution proof. With the check inert, the link is kept: the agent goes on claiming a card
nobody is working, and Reports Health Check renders it as RUNNING.

Reached through the private method for the same reason as `executor-worktree-owner-renamed-lanes.test.ts`
— the public route is the heartbeat poll loop, and standing that up would make this a test about polling
rather than about the lane set.

REVERT CHECK, measured: dropping the resolved `parkedColumns` argument (back to `isParkedTaskColumn(
linkedTask)`) fails the RENAMED case — the stale link is not cleared.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

function parkedCard(vocab: Vocabulary): Task {
  return {
    id: "FN-PARKED",
    title: "parked, nobody working it",
    description: "",
    /* The HOLD lane — parked by definition, and renamed on the custom board. */
    column: vocab.hold,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  } as Task;
}

function harness(vocab: Vocabulary) {
  const ir: WorkflowIr = lifecycleIr(vocab, "heartbeat-parked");
  const agent = { id: "a1", name: "A", role: "executor", state: "running", taskId: "FN-PARKED" };
  const store = {
    listAgents: vi.fn().mockResolvedValue([agent]),
    getAgent: vi.fn().mockResolvedValue(agent),
    getCachedAgent: vi.fn().mockReturnValue(null),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    updateAgent: vi.fn(),
    updateAgentState: vi.fn(),
    assignTask: vi.fn(),
    recordHeartbeat: vi.fn(),
    getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
    /*
    Load-bearing: the clear path calls this, and `reconcileOrphanedRunningAgents` CATCHES its own
    errors and only warns. Omit it and the sweep silently does nothing — the first version of this
    test "passed" its negative case that way, which is the incomplete-fake defect this program has
    documented.
    */
    syncExecutionTaskLink: vi.fn(),
    endHeartbeatRun: vi.fn(),
  };
  const taskStore = {
    getSettings: vi.fn().mockResolvedValue({}),
    getTask: vi.fn().mockResolvedValue(parkedCard(vocab)),
    listTasks: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
    logEntry: vi.fn(),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "heartbeat-parked", stepIds: [] })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "heartbeat-parked", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "heartbeat-parked" ? { ir } : undefined)),
  } as unknown as TaskStore;

  const monitor = new HeartbeatMonitor({ store: store as never, taskStore, rootDir: "/repo" });
  return { monitor, store, taskStore };
}

/** The private sweep under test; see the header for why this is reached directly. */
function reconcile(monitor: HeartbeatMonitor): Promise<void> {
  return (monitor as unknown as { reconcileOrphanedRunningAgents: () => Promise<void> })
    .reconcileOrphanedRunningAgents();
}

describe("the parked-link sweep resolves its lanes by ROLE, not by the legacy default", () => {
  for (const [label, vocab] of [["DEFAULT", DEFAULT_VOCAB], ["RENAMED", RENAMED_VOCAB]] as const) {
    it(`clears a stale link to a card parked in a ${label} hold lane (${vocab.hold})`, async () => {
      const { monitor, store } = harness(vocab);

      await reconcile(monitor);

      // The link is dropped: the agent stops claiming a card nobody is working.
      expect(store.syncExecutionTaskLink).toHaveBeenCalledWith("a1", undefined);
    });
  }

  it("leaves the link alone when the card is NOT in a parked lane on a RENAMED board", async () => {
    /*
    Non-vacuous companion: without it, a sweep that cleared every link would satisfy both cases above.
    Same renamed board, same agent — only the card's lane changes, to the one lane where work is live.
    */
    const { monitor, store, taskStore } = harness(RENAMED_VOCAB);
    (taskStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...parkedCard(RENAMED_VOCAB),
      column: RENAMED_VOCAB.wip,
    });

    await reconcile(monitor);

    expect(store.syncExecutionTaskLink).not.toHaveBeenCalled();
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-00:20 (#2820 review — greptile P2):
THE SECOND CALL SITE. The commit converted BOTH `isParkedTaskColumn` callers but the tests drove only
`reconcileOrphanedRunningAgents`. `buildReportsHealthSection` resolves its lanes independently and
rewrites the rendered report, so it is a separate surface and needed its own case — converting two
copies and testing one is the Surface Enumeration failure this program keeps paying for.

What it does on the parked path: renders the state as `active` rather than `running` and annotates the
task as "queued/no live run", which is the operator-visible half of the same defect. With the lanes
unresolved on a renamed board the report kept saying RUNNING.

REVERT CHECK, measured: dropping the resolved argument here fails the RENAMED case — the section still
reports `running`.
*/
function buildHealth(monitor: HeartbeatMonitor, agentStore: unknown): Promise<string | null> {
  return (monitor as unknown as {
    buildReportsHealthSection: (agentId: string, agentStore: unknown) => Promise<string | null>;
  }).buildReportsHealthSection("boss", agentStore);
}

describe("the reports health section resolves its parked lanes by ROLE", () => {
  for (const [label, vocab] of [["DEFAULT", DEFAULT_VOCAB], ["RENAMED", RENAMED_VOCAB]] as const) {
    it(`renders a parked report as queued on a ${label} hold lane (${vocab.hold})`, async () => {
      const { monitor, store } = harness(vocab);
      /* The direct report is the running agent linked to the parked card. */
      store.getAgentsByReportsTo.mockResolvedValue([
        { id: "a1", name: "A", role: "executor", state: "running", taskId: "FN-PARKED", lastHeartbeatAt: new Date().toISOString() },
      ]);

      const section = await buildHealth(monitor, store);

      expect(section).toContain("queued/no live run");
    });
  }

  it("still reports a live report as running on a RENAMED board", async () => {
    /*
    Non-vacuous companion: without it, a section that annotated every report would satisfy the cases
    above. Same renamed board, same agent — only the card's lane changes to the wip one.
    */
    const { monitor, store, taskStore } = harness(RENAMED_VOCAB);
    (taskStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...parkedCard(RENAMED_VOCAB),
      column: RENAMED_VOCAB.wip,
    });
    store.getAgentsByReportsTo.mockResolvedValue([
      { id: "a1", name: "A", role: "executor", state: "running", taskId: "FN-PARKED", lastHeartbeatAt: new Date().toISOString() },
    ]);

    const section = await buildHealth(monitor, store);

    expect(section).not.toContain("queued/no live run");
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-15:10 (#2820 review — greptile P1):
THE ARITY TRAP, fifth occurrence in this program. My first version read the parked lanes through
`resolveTaskLifecycleColumns`, which returns the FIRST column carrying each trait. A workflow declaring
TWO hold lanes had only one recognised, so a card parked in the SECOND one still read as live and its
stale link was never cleared — the very defect the fix exists to close, one degree narrower.

`resolveLifecycleColumns` answers "which column is THE hold lane?"; this code needs "is this card in ANY
parked lane?". Those are different questions and nothing in the types distinguishes them, which is why
this keeps recurring.

The default board cannot express this shape — it has one hold lane — so only a multi-lane fixture can
catch it.

REVERT CHECK, measured: reading the lanes through `resolveTaskLifecycleColumns` again fails this case,
because `secondary-hold` is not the first hold column.
*/
const TWO_HOLD_IR = {
  version: "v2",
  id: "heartbeat-parked",
  name: "two holds",
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "secondary-hold", name: "Blocked", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
  ],
  nodes: [{ id: "start", kind: "start", column: "backlog" }],
  edges: [],
} as unknown as WorkflowIr;

describe("every parked lane counts, not just the first one the resolver returns", () => {
  it("clears a stale link to a card parked in the SECOND hold lane", async () => {
    const tasksById = new Map([["FN-PARKED", { ...parkedCard(DEFAULT_VOCAB), column: "secondary-hold" } as Task]]);
    const agent = { id: "a1", name: "A", role: "executor", state: "running", taskId: "FN-PARKED" };
    const store = {
      listAgents: vi.fn().mockResolvedValue([agent]),
      getAgent: vi.fn().mockResolvedValue(agent),
      getCachedAgent: vi.fn().mockReturnValue(null),
      getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
      updateAgent: vi.fn(),
      updateAgentState: vi.fn(),
      assignTask: vi.fn(),
      recordHeartbeat: vi.fn(),
      getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
      syncExecutionTaskLink: vi.fn(),
      endHeartbeatRun: vi.fn(),
    };
    const taskStore = {
      getSettings: vi.fn().mockResolvedValue({}),
      getTask: vi.fn(async (id: string) => tasksById.get(id)),
      listTasks: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn(),
      moveTask: vi.fn(),
      logEntry: vi.fn(),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "heartbeat-parked", stepIds: [] })),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "heartbeat-parked", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async (id: string) => (id === "heartbeat-parked" ? { ir: TWO_HOLD_IR } : undefined)),
    } as unknown as TaskStore;

    const monitor = new HeartbeatMonitor({ store: store as never, taskStore, rootDir: "/repo" });
    await reconcile(monitor);

    expect(store.syncExecutionTaskLink).toHaveBeenCalledWith("a1", undefined);
  });
});
