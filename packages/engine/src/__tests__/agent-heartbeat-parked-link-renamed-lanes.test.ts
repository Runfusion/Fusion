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
