/*
FNXC:ReviewerWakeCandidacy 2026-10-19-12:40 (RUFU-369):
Drives the real `executeHeartbeat` wake path, because the defect lived in the path, not in a helper: the wake
resolved a card, printed a review instruction, and opened a session on cards whose lifecycle cannot carry the
gate it named.

  RUFU-350  `column: done`, `status: done`, content landed, `code-review` APPROVED at 07:22:33Z, woken 07:41Z.
  RUFU-365  `column: todo`, 0 of 8 steps, `**No commits expected:** true`, woken with "2 new comments" that were
            a previous wake's carried `triggeringCommentIds`.

What this pins, in both directions:
- a timer wake that resolves `agent.taskId` passes the SAME candidacy seam as an explicit wake (it is the same
  `explicitTaskId ?? agent.taskId` resolution, so a separate timer guard would only drift);
- the withheld wake produces the named decline + audit row and changes NOTHING else: no session, no `moveTask`,
  no `status: "failed"`, no raw agent unbind — `reconcile-lane-capability-misbind` stays the sole mutation owner;
- an automation wake (the review-dispatch sweep) and a fresh-comment wake are never swallowed — RUFU-682 measured
  24 re-dispatches of SANE-484 after a refusal at this seam;
- a carried comment snapshot is no longer re-advertised as new comment delivery.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Agent, AgentHeartbeatRun, AgentStore, TaskStore, WorkflowIr } from "@fusion/core";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import * as worktreeAcquisition from "../worktree/worktree-acquisition.js";
import { createBudgetStatus } from "./heartbeat-test-helpers.js";

const WF = "custom:review-candidacy";

const sessionFactory = vi.hoisted(() => ({
  createResolvedAgentSession: vi.fn(),
  promptWithFallback: vi.fn(async (session: { prompt(text: string): Promise<unknown> }, text: string) => {
    await session.prompt(text);
  }),
}));

vi.mock("../agents/agent-session-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-session-helpers.js")>()),
  createResolvedAgentSession: sessionFactory.createResolvedAgentSession,
}));

vi.mock("../pi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pi.js")>()),
  promptWithFallback: sessionFactory.promptWithFallback,
}));

/**
 * Lanes named for what they are: `building` is the only WIP lane, `assessing` is the review lane
 * (`merge-blocker` is review-class), `shipped` is terminal.
 */
function reviewI(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "queued", name: "queued", traits: [{ trait: "hold", config: { release: "manual" } }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "assessing", name: "assessing", traits: [{ trait: "merge-blocker" }] },
      // A parked lane carrying no work-class trait: neither implementation- nor review-class, and not terminal.
      { id: "parked", name: "parked", traits: [] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

const taskFixture = (patch: Record<string, unknown> = {}) => ({
  id: "RUFU-369",
  title: "Card woken for a review it cannot carry",
  description: "d",
  prompt: "# PROMPT",
  column: "shipped",
  status: "done",
  assignedAgentId: "agent-review",
  worktree: "/wt/RUFU-369",
  branch: "fusion/rufu-369",
  dependencies: [],
  steps: [],
  log: [],
  noCommitsExpected: false,
  reviewLevel: 2,
  enabledWorkflowSteps: ["plan-review", "code-review"],
  workflowStepResults: [{ workflowStepId: "code-review", status: "passed", verdict: "APPROVE" }],
  ...patch,
});

function agentFixture(patch: Record<string, unknown> = {}): Agent {
  return {
    id: "agent-review",
    name: "review lane",
    role: "reviewer",
    roles: ["reviewer"],
    state: "active",
    taskId: "RUFU-369",
    createdAt: "",
    updatedAt: "",
    metadata: {},
    runtimeConfig: { enabled: true },
    ...patch,
  } as unknown as Agent;
}

function createAgentStore(overrides: Record<string, unknown> = {}): AgentStore {
  const run = {
    id: "run-candidacy",
    agentId: "agent-review",
    status: "active",
    startedAt: new Date().toISOString(),
    endedAt: null,
  } as unknown as AgentHeartbeatRun;
  return {
    getAgent: vi.fn().mockResolvedValue(agentFixture()),
    getAgentsByTaskId: vi.fn().mockResolvedValue([]),
    // FNXC:HeartbeatRunPersistence 2026-10-23-05:49 moved run ownership (invocation source, trigger detail,
    // context snapshot, pid) INTO the initial active-row write: `startRun` no longer re-publishes it through
    // `saveRun`. The fake must echo `initialMetadata` onto the row it returns or the test observes a row the
    // code under test never wrote — the wake's `contextSnapshot` (triggering vs carried comment ids) then
    // disappears and the snapshot assertions below fail against `undefined`.
    startHeartbeatRun: vi.fn(async (_agentId: string, initialMetadata: Record<string, unknown> = {}) => {
      Object.assign(run, initialMetadata);
      return run;
    }),
    saveRun: vi.fn(async (written: AgentHeartbeatRun) => {
      Object.assign(run, written);
      return run;
    }),
    getRunDetail: vi.fn().mockResolvedValue(run),
    endHeartbeatRun: vi.fn(),
    updateAgentState: vi.fn(),
    updateAgent: vi.fn(),
    assignTask: vi.fn(),
    recordHeartbeat: vi.fn(),
    getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
    getCachedAgent: vi.fn().mockReturnValue(null),
    getLastBlockedState: vi.fn().mockResolvedValue(null),
    setLastBlockedState: vi.fn(),
    clearLastBlockedState: vi.fn(),
    appendRunLog: vi.fn(),
    getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
    getRecentRuns: vi.fn().mockResolvedValue([]),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AgentStore;
}

function createTaskStore(task: Record<string, unknown>, overrides: Record<string, unknown> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getTask: vi.fn().mockResolvedValue(task),
    getTasksByAssignedAgent: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([]),
    selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    moveTask: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: WF, stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: WF, stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ ir: reviewI() })),
    ...overrides,
  } as unknown as TaskStore;
}

describe("reviewer wake candidacy at the heartbeat seam", () => {
  let store: ReturnType<typeof createAgentStore>;
  let taskStore: TaskStore;
  let acquireSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createAgentStore();
    acquireSpy = vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockImplementation(
      async () => ({ mode: "new", worktreePath: "/wt/RUFU-369", refreshedBase: "abcdef" }) as never,
    );
    sessionFactory.createResolvedAgentSession.mockImplementation(async () => ({
      session: { prompt: vi.fn(async () => {}), dispose: vi.fn(), subscribe: vi.fn(() => () => {}) },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function monitor(task: Record<string, unknown>, agent: Agent = agentFixture()) {
    store = createAgentStore({ getAgent: vi.fn().mockResolvedValue(agent) });
    taskStore = createTaskStore(task);
    return new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
  }

  /** Every `task:lane-capability-declined` audit row the run wrote. */
  function declines(): Array<Record<string, unknown>> {
    return (taskStore.recordRunAuditEvent as unknown as ReturnType<typeof vi.fn>)
      .mock.calls
      .map((call) => call[0] as { mutationType?: string; metadata?: Record<string, unknown> })
      .filter((row) => row.mutationType === "task:lane-capability-declined")
      .map((row) => row.metadata ?? {});
  }

  it("withholds a timer wake on a landed card whose code review already approved", async () => {
    const m = monitor(taskFixture());
    const run = await m.executeHeartbeat({ agentId: "agent-review", source: "timer" });

    expect(sessionFactory.createResolvedAgentSession).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(declines()).toEqual([
      expect.objectContaining({
        agentId: "agent-review",
        taskId: "RUFU-369",
        column: "shipped",
        code: "review-candidacy-mismatch",
      }),
    ]);
    // Decline ≠ lifecycle change: no move, no failure write, no raw unbind of the binding.
    expect((taskStore.moveTask as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((taskStore.updateTask as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    const unbindWrites = (store.updateAgent as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => (call[0] as { taskId?: unknown })?.taskId === null);
    expect(unbindWrites).toEqual([]);
    expect(run.status).not.toBe("failed");
  });

  it("withholds the same card on an explicit wake too — one seam, not one per trigger", async () => {
    const m = monitor(taskFixture());
    await m.executeHeartbeat({ agentId: "agent-review", source: "manual", taskId: "RUFU-369" });
    expect(sessionFactory.createResolvedAgentSession).not.toHaveBeenCalled();
    expect(declines()[0]).toEqual(expect.objectContaining({ code: "review-candidacy-mismatch" }));
  });

  it("withholds a reviewer-only lane on a parked non-work lane whose review already approved", async () => {
    // RUFU-350's shape: the card is neither terminal nor implementation-class, so the pre-existing bind verdict
    // allowed it and the session ran on a closed gate; only candidacy knows the gate is shut.
    const m = monitor(taskFixture({ column: "parked", status: "in-progress" }));
    await m.executeHeartbeat({ agentId: "agent-review", source: "timer" });
    expect(sessionFactory.createResolvedAgentSession).not.toHaveBeenCalled();
    expect(declines()[0]).toEqual(expect.objectContaining({ code: "review-candidacy-mismatch", column: "parked" }));
  });

  it("withholds a card whose plan declared zero commits, naming candidacy as the refusing arm", async () => {
    const m = monitor(taskFixture({ column: "assessing", status: "in-review", workflowStepResults: [], noCommitsExpected: true }));
    await m.executeHeartbeat({ agentId: "agent-review", source: "timer" });
    expect(sessionFactory.createResolvedAgentSession).not.toHaveBeenCalled();
    // The code is the proof of WHICH arm refused: the lane-capability arm would say `lane-capability-mismatch`.
    // The sentence naming `No commits expected` lives on the card's History line, never in audit metadata.
    expect(declines()[0]).toEqual(expect.objectContaining({ code: "review-candidacy-mismatch", column: "assessing" }));
  });

  it("still runs the review wake for a card the merge door is actually waiting on", async () => {
    // A review lane that can also execute is what real reviewer lanes are: candidacy must not touch it while
    // the card is a genuine candidate, or the merge door's review is refused (the RUFU-682 over-refusal class).
    const reviewingExecutor = agentFixture({ id: "agent-rev-exec", role: "reviewer", roles: ["reviewer", "executor"] });
    const m = monitor(taskFixture({ column: "assessing", status: "in-review", workflowStepResults: [] }), reviewingExecutor);
    await m.executeHeartbeat({ agentId: "agent-rev-exec", source: "automation", taskId: "RUFU-369" });
    expect(sessionFactory.createResolvedAgentSession).toHaveBeenCalledTimes(1);
    expect(declines()).toEqual([]);
  });

  it("never swallows an automation wake on a non-candidate — RUFU-682 stayed fixed", async () => {
    const m = monitor(taskFixture({ column: "parked", status: "in-progress" }));
    await m.executeHeartbeat({ agentId: "agent-review", source: "automation", taskId: "RUFU-369" });
    expect(declines()).toEqual([]);
    expect(sessionFactory.createResolvedAgentSession).toHaveBeenCalledTimes(1);
  });

  it("never swallows a fresh comment delivery on a non-candidate", async () => {
    // A parked card the pre-existing bind verdict waves through (it is not implementation-class), woken by an
    // operator comment the reviewer must still be allowed to read.
    const m = monitor(taskFixture({ column: "parked", status: "in-progress", workflowStepResults: [] }));
    await m.executeHeartbeat({
      agentId: "agent-review",
      source: "on_demand",
      triggerDetail: "wake-on-comment",
      taskId: "RUFU-369",
      triggeringCommentIds: ["c-new"],
      triggeringCommentType: "task",
    });
    expect(declines()).toEqual([]);
    expect(sessionFactory.createResolvedAgentSession).toHaveBeenCalledTimes(1);
  });

  it("advertises a carried comment snapshot as carried context, never as new delivery", async () => {
    const executor = agentFixture({ id: "agent-exec", role: "executor", roles: ["executor"] });
    const m = monitor(taskFixture({ column: "building", status: "in-progress", assignedAgentId: "agent-exec" }), executor);
    const run = await m.executeHeartbeat({
      agentId: "agent-exec",
      source: "timer",
      contextSnapshot: { taskId: "RUFU-369", triggeringCommentIds: ["c-old"] },
    });

    expect(sessionFactory.createResolvedAgentSession).toHaveBeenCalledTimes(1);
    const prompt = String(sessionFactory.promptWithFallback.mock.calls[0][1]);
    expect(prompt).toContain("Carried");
    expect(prompt).not.toContain("New comments since last run");
    // The next wake must not inherit a fresh stamp for an id that was already delivered.
    expect((run.contextSnapshot as Record<string, unknown>)?.triggeringCommentIds).toBeUndefined();
    expect((run.contextSnapshot as Record<string, unknown>)?.carriedTriggeringCommentIds).toEqual(["c-old"]);
  });

  it("advertises a genuinely new comment as new", async () => {
    const executor = agentFixture({ id: "agent-exec", role: "executor", roles: ["executor"] });
    const m = monitor(taskFixture({ column: "building", status: "in-progress", assignedAgentId: "agent-exec" }), executor);
    const run = await m.executeHeartbeat({
      agentId: "agent-exec",
      source: "on_demand",
      triggerDetail: "wake-on-comment",
      triggeringCommentIds: ["c-new"],
      triggeringCommentType: "task",
    });
    const prompt = String(sessionFactory.promptWithFallback.mock.calls[0][1]);
    expect(prompt).toContain("New comments since last run");
    expect((run.contextSnapshot as Record<string, unknown>)?.triggeringCommentIds).toEqual(["c-new"]);
  });

  it("leaves an executor lane's behavior on an implementation card untouched", async () => {
    const executor = agentFixture({ id: "agent-exec", role: "executor", roles: ["executor"] });
    const m = monitor(taskFixture({ column: "building", status: "in-progress", assignedAgentId: "agent-exec" }), executor);
    await m.executeHeartbeat({ agentId: "agent-exec", source: "timer" });
    expect(sessionFactory.createResolvedAgentSession).toHaveBeenCalledTimes(1);
    expect(declines()).toEqual([]);
  });
});
