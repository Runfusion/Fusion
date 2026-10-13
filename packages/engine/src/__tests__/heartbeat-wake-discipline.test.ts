/*
FNXC:HeartbeatWakeDiscipline 2026-10-13 (STAS-300):

TWO MEASURED ENGINE DEFECTS, ONE CONTRACT.

(A) A heartbeat whose `fn_heartbeat_done` the engine ACCEPTED kept being
    re-dispatched on every timer tick with a byte-identical wake delta. Measured
    in the live run store (STAS project, `project.agent_runs`, 2026-10-13):
    agent-ff03cfcc produced streaks of 15, 16, 17, 18 and 30 consecutive timer
    runs whose persisted `executionPrompt` hashed identically — the 17-tick
    streak ran 03:22Z→07:22Z on the day of measurement, and the 15-tick streak
    2026-09-27T20:05Z→09-28T00:27Z is the incident the card was filed from.
    Root cause is a missing persistence, not a race: an acknowledged run records
    only `toolCallCount` / `summary` / `reason`, so `fn_heartbeat_done` (a local
    boolean) leaves nothing for the next tick to compare itself against.
    The contract below makes the acknowledgement and the wake-signal cursors it
    covers durable, and lets a timer tick PROVE it has nothing new before it
    spends a full agent session.

(B) The wake delta's `- pending messages: N` was not the number the agent's own
    `fn_read_messages` could reproduce. Measured over the same store: the
    rendered N never exceeded 10 while the very same inbox rows held up to 31
    unread for that recipient at that instant (16 of 22 `N=10` renders
    understated the store, by up to 21), and 58 runs flipped MORE rows read than
    they advertised — 162 messages were marked read that the agent was never
    shown (worst single run: rendered 10, swept 32). Both numbers come from the
    same two lines of code: a `limit: 10` preview whose `.length` was rendered as
    a total, and a blanket `markAllAsRead` that retired rows beyond that preview.

    So: the rendered count is the store's unread total or it is absent (never a
    preview length, never a false 0), and consumption is scoped to exactly the
    ids the run surfaced. One store, one number, one consumption.

    Suppression is conservative by construction: any uncertainty (no cursor, an
    unrecognised cursor shape, a failed or unacknowledged prior run, a throwing
    probe) dispatches. A suppressed tick creates neither a run record nor a
    session; a budget- or pause-owing agent keeps getting its observability run
    record, and manual / assignment / automation / comment / message wakes are
    untouched because the gate sits on the timer path only.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { HeartbeatMonitor, HeartbeatTriggerScheduler } from "../agent-heartbeat.js";
import { createBudgetStatus, createMessage } from "./heartbeat-test-helpers.js";
import type { Agent, AgentHeartbeatRun, AgentStore, Message, MessageStore, TaskStore } from "@fusion/core";

vi.mock("../logger.js", async () => {
  const { formatMockError } = await import("./heartbeat-test-helpers.js");
  const quietLogger = () => ({
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return {
    createLogger: vi.fn(() => quietLogger()),
    heartbeatLog: quietLogger(),
    formatError: formatMockError,
  };
});
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: any, prompt: string) => {
    await session.prompt(prompt);
  }),
}));
vi.mock("../worktree/worktree-acquisition.js", () => ({ acquireTaskWorktree: vi.fn() }));

import { createFnAgent } from "../pi.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import { heartbeatLog } from "../logger.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);
const mockedAcquireTaskWorktree = vi.mocked(acquireTaskWorktree);

const AGENT_ID = "agent-wake-1";
const TASK_ID = "FN-700";

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: "Wake Discipline Agent",
    role: "executor",
    state: "active",
    taskId: TASK_ID,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    metadata: {},
    ...overrides,
  } as Agent;
}

function mockSession() {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(),
    model: { provider: "mock", id: "mock-model" },
  };
}

/** An acknowledged completed run with wake cursors, as the store would hold it. */
function acknowledgedRun(overrides: Partial<AgentHeartbeatRun> = {}): AgentHeartbeatRun {
  return {
    id: "run-ack",
    agentId: AGENT_ID,
    startedAt: "2026-10-13T06:00:00.000Z",
    endedAt: "2026-10-13T06:05:00.000Z",
    status: "completed",
    resultJson: {
      summary: "Nothing to do.",
      heartbeatDoneAccepted: true,
      wakeCursor: {
        consumedMessageIds: ["msg-shown-1"],
        roomEntryIds: ["room-entry-1"],
        surfacedCommentIds: [],
        boardState: {
          assignedTaskId: TASK_ID,
          assignedTaskState: "in-progress",
          assignedRows: [`${TASK_ID}:in-progress`],
          autoClaimCandidates: [],
        },
      },
    },
    ...overrides,
  } as unknown as AgentHeartbeatRun;
}

interface Harness {
  agent: Agent;
  store: AgentStore;
  messageStore: MessageStore & {
    getInbox: ReturnType<typeof vi.fn>;
    getMailbox: ReturnType<typeof vi.fn>;
    markInboxAsRead: ReturnType<typeof vi.fn>;
    markAllAsRead: ReturnType<typeof vi.fn>;
  };
  taskStore: TaskStore;
  monitor: HeartbeatMonitor;
  savedRuns: AgentHeartbeatRun[];
  session: ReturnType<typeof mockSession>;
  /** Simulates the session calling an engine-offered tool while its prompt is running. */
  invokeTool: (name: string, params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * A store holding `unreadTotal` unread rows for the agent while the capped
 * `limit: 10` inbox query returns at most 10 of them — the exact shape that made
 * the live counter saturate at 10 over a store of up to 31.
 */
function createHarness(opts: {
  unreadTotal?: number;
  priorRuns?: AgentHeartbeatRun[];
  budget?: ReturnType<typeof createBudgetStatus>;
  agent?: Agent;
  roomEntries?: Array<{ id: string }>;
  taskComments?: Array<{ id: string }>;
  assignedTasks?: Array<{ id: string; column: string; assignedAgentId?: string; paused?: boolean; userPaused?: boolean }>;
  boardTasks?: Array<Record<string, unknown>>;
  withMessageStore?: boolean;
} = {}): Harness {
  const agent = baseAgent(opts.agent ?? {});
  const unreadTotal = opts.unreadTotal ?? 0;
  const allMessages: Message[] = Array.from({ length: unreadTotal }, (_unused, index) =>
    createMessage({
      id: `msg-shown-${index + 1}`,
      fromId: "user-1",
      fromType: "user",
      toId: AGENT_ID,
      toType: "agent",
      content: `inbox body ${index + 1}`,
      createdAt: `2026-10-13T05:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }),
  );
  const savedRuns: AgentHeartbeatRun[] = [];
  const session = mockSession();
  const offeredTools = new Map<string, { execute?: (id: string, params: never) => Promise<unknown> }>();
  mockedCreateFnAgent.mockImplementation(async (options: { customTools?: Array<{ name: string; execute?: (id: string, params: never) => Promise<unknown> }> }) => {
    offeredTools.clear();
    for (const tool of options.customTools ?? []) offeredTools.set(tool.name, tool);
    return { session: session as never } as never;
  });
  const invokeTool = async (name: string, params: Record<string, unknown>) => {
    const tool = offeredTools.get(name);
    if (!tool?.execute) throw new Error(`harness: the session was never offered ${name}`);
    return tool.execute(`tool-call-${name}`, params as never);
  };

  const store = {
    getAgent: vi.fn().mockResolvedValue(agent),
    assignTask: vi.fn().mockResolvedValue(agent),
    claimTaskForAgent: vi.fn().mockResolvedValue({ ok: false, reason: "task_not_found" }),
    handoffTaskToWorkflowExecutor: vi.fn().mockResolvedValue({ ok: true, task: { id: TASK_ID } }),
    startHeartbeatRun: vi.fn().mockImplementation(async () => ({
      id: "run-current",
      agentId: AGENT_ID,
      startedAt: "2026-10-13T07:00:00.000Z",
      endedAt: null,
      status: "active",
    })),
    saveRun: vi.fn().mockImplementation(async (run: AgentHeartbeatRun) => {
      savedRuns.push({ agentId: AGENT_ID, ...run });
    }),
    endHeartbeatRun: vi.fn(async (runId: string, status: string) => {
      const prior = [...savedRuns].reverse().find((run) => run.id === runId);
      savedRuns.push({ ...(prior ?? ({} as AgentHeartbeatRun)), id: runId, status } as AgentHeartbeatRun);
    }),
    getRunDetail: vi.fn(async (agentId: string, runId: string) =>
      [...savedRuns].reverse().find((run) => run.id === runId && run.agentId === agentId) ?? null),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    getRecentRuns: vi.fn().mockResolvedValue(opts.priorRuns ?? []),
    getCompletedHeartbeatRuns: vi.fn().mockResolvedValue((opts.priorRuns ?? []).filter((r) => r.status !== "active")),
    getBudgetStatus: vi.fn().mockResolvedValue(opts.budget ?? createBudgetStatus()),
    getCachedAgent: vi.fn().mockReturnValue(null),
    getLastBlockedState: vi.fn().mockResolvedValue(null),
    setLastBlockedState: vi.fn().mockResolvedValue(undefined),
    clearLastBlockedState: vi.fn().mockResolvedValue(undefined),
    appendRunLog: vi.fn().mockResolvedValue(undefined),
    getRatingSummary: vi.fn().mockResolvedValue(undefined),
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    updateAgent: vi.fn().mockResolvedValue(agent),
    updateAgentState: vi.fn().mockResolvedValue(undefined),
    syncExecutionTaskLink: vi.fn().mockResolvedValue(undefined),
    getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
  } as unknown as AgentStore;

  const chatStore = {
    listRoomsForAgent: vi.fn().mockResolvedValue([{ id: "room-1", name: "Ops", status: "active" }]),
    listRoomMessagesSince: vi.fn().mockResolvedValue(opts.roomEntries ?? []),
    getRoomMessages: vi.fn().mockResolvedValue(opts.roomEntries ?? []),
    listRoomMembers: vi.fn().mockResolvedValue([]),
  };

  const messageStore = {
    setMessageToAgentHook: vi.fn(),
    getInbox: vi.fn().mockImplementation(async (_id: string, _type: string, filter?: { limit?: number }) =>
      allMessages.slice(0, filter?.limit ?? allMessages.length),
    ),
    getMailbox: vi.fn().mockResolvedValue({
      ownerId: AGENT_ID,
      ownerType: "agent",
      unreadCount: unreadTotal,
      lastMessage: allMessages[allMessages.length - 1],
    }),
    markInboxAsRead: vi.fn().mockImplementation(async (_id: string, _type: string, ids: string[]) => ids),
    markAllAsRead: vi.fn().mockResolvedValue(unreadTotal),
  } as unknown as MessageStore & {
    getInbox: ReturnType<typeof vi.fn>;
    getMailbox: ReturnType<typeof vi.fn>;
    markInboxAsRead: ReturnType<typeof vi.fn>;
    markAllAsRead: ReturnType<typeof vi.fn>;
  };

  const taskStore = {
    getTask: vi.fn().mockResolvedValue({
      id: TASK_ID,
      title: "Wake discipline task",
      description: "body",
      prompt: "# PROMPT\ncontent",
      steps: [],
      column: "in-progress",
      worktree: "/tmp/wt",
      branch: "fusion/fn-700",
      dependencies: [],
      log: [],
      attachments: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    }),
    getSettings: vi.fn().mockResolvedValue({}),
    listTasks: vi.fn().mockResolvedValue(opts.boardTasks ?? []),
    /*
    A steering/task comment lives on the task row (`task.steeringComments`), which is the same
    read the wake-signal probe performs — there is no separate comment-store endpoint to fake.
    */
    getTasksByAssignedAgent: vi.fn().mockResolvedValue(
      (opts.assignedTasks ?? [{ id: TASK_ID, column: "in-progress", assignedAgentId: AGENT_ID }]).map((task) => ({
        ...task,
        steeringComments: opts.taskComments ?? [],
      })),
    ),
    selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue({}),
    getMissionStore: vi.fn().mockReturnValue(null),
    findRecentTasksBySourceParentTaskId: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue({ id: "FN-701", description: "x", dependencies: [], column: "triage" }),
    upsertTaskDocument: vi.fn().mockResolvedValue({}),
    getTaskDocument: vi.fn().mockResolvedValue(null),
    listTaskDocuments: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;

  const monitor = new HeartbeatMonitor({
    store,
    ...(opts.withMessageStore === false ? {} : { messageStore }),
    taskStore,
    chatStore: chatStore as never,
    rootDir: "/tmp",
  });

  return { agent, store, messageStore, taskStore, monitor, savedRuns, session, invokeTool };
}

function lastPrompt(session: Harness["session"]): string {
  const calls = session.prompt.mock.calls as unknown as string[][];
  return calls[calls.length - 1]?.[0] ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCreateFnAgent.mockResolvedValue({ session: mockSession() as never } as never);
  mockedAcquireTaskWorktree.mockResolvedValue({
    worktreePath: "/tmp/wt",
    branch: "fusion/fn-700",
    source: "existing",
    hydrated: false,
    isResume: true,
  } as never);
});

describe("(B) the wake-delta pending-messages count is the inbox store's own truth", () => {
  it("renders the store's unread total, never the length of the capped preview", async () => {
    const h = createHarness({ unreadTotal: 12 });

    await h.monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

    const prompt = lastPrompt(h.session);
    expect(prompt).toContain("- pending messages: 12");
    expect(prompt).not.toContain("- pending messages: 10");
    expect(prompt).toContain("- inbox snapshot: 12 message(s)");
  });

  it("agrees with what the same store hands the agent's own read tool at the same moment", async () => {
    const h = createHarness({ unreadTotal: 12 });

    await h.monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

    const toolVisible = await h.messageStore.getInbox(AGENT_ID, "agent", { read: false, limit: 20 });
    const rendered = lastPrompt(h.session).match(/- pending messages: (\d+)/)?.[1];
    expect(rendered).toBe(String(toolVisible.length));
    expect(rendered).toBe("12");
  });

  it("renders the store total in the wake-trigger diagnostics too, so no second counter survives", async () => {
    const h = createHarness({ unreadTotal: 12 });

    await h.monitor.executeHeartbeat({
      agentId: AGENT_ID,
      source: "on_demand",
      triggerDetail: "wake-on-message",
      wakeMessage: {
        messageId: "msg-shown-1",
        fromType: "user",
        fromId: "user-1",
        forced: false,
        createdAt: "2026-10-13T05:00:00.000Z",
      },
    });

    expect(vi.mocked(heartbeatLog.log)).toHaveBeenCalledWith(
      expect.stringMatching(/\[wake-trigger-diagnostics\].*inboxUnreadCount=12/),
    );
  });

  it("omits the line and fails loud when no authoritative message store exists", async () => {
    const h = createHarness({ withMessageStore: false });

    await h.monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

    expect(lastPrompt(h.session)).not.toMatch(/- pending messages:/);
    expect(vi.mocked(heartbeatLog.warn)).toHaveBeenCalledWith(
      expect.stringContaining("pending-messages-count-unavailable"),
    );
  });
});

describe("(B) consumption retires exactly what the agent was shown", () => {
  it("marks the surfaced ids read and never runs a blanket sweep", async () => {
    const h = createHarness({ unreadTotal: 12 });

    await h.monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

    expect(h.messageStore.markAllAsRead).not.toHaveBeenCalled();
    const consumed = h.messageStore.markInboxAsRead.mock.calls.flatMap((call) => call[2] as string[]);
    expect(consumed).toEqual(
      Array.from({ length: 10 }, (_unused, index) => `msg-shown-${index + 1}`),
    );
  });

  it("leaves a message that was never surfaced unread, so the next tick still sees it", async () => {
    const h = createHarness({ unreadTotal: 12 });

    await h.monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

    const consumed = h.messageStore.markInboxAsRead.mock.calls.flatMap((call) => call[2] as string[]);
    expect(consumed.length).toBeGreaterThan(0);
    expect(consumed).not.toContain("msg-shown-11");
    expect(consumed).not.toContain("msg-shown-12");
  });
});

describe("(A) an acknowledged completion persists what it acknowledged", () => {
  it("records the acknowledgement and its wake cursors in the completed run", async () => {
    const h = createHarness({ unreadTotal: 2 });
    // The session acknowledges the heartbeat, exactly as the real tool call does mid-run.
    h.session.prompt.mockImplementation(async () => {
      await h.invokeTool("fn_heartbeat_done", { summary: "Nothing to do." });
    });

    const run = await h.monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

    expect(run.status).toBe("completed");
    const resultJson = h.savedRuns[h.savedRuns.length - 1]?.resultJson ?? run.resultJson;
    expect(resultJson).toMatchObject({
      heartbeatDoneAccepted: true,
      wakeCursor: { consumedMessageIds: ["msg-shown-1", "msg-shown-2"] },
    });
  });

  it("persists no acknowledgement for a run the agent never acknowledged", async () => {
    const h = createHarness({ unreadTotal: 2 });
    // The session ends without ever calling fn_heartbeat_done.
    h.session.prompt.mockResolvedValue(undefined);

    const run = await h.monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

    const resultJson = h.savedRuns[h.savedRuns.length - 1]?.resultJson ?? run.resultJson;
    expect(resultJson).not.toHaveProperty("heartbeatDoneAccepted");
  });
});

describe("(A) timer dispatch requires something newer than the persisted cursors", () => {
  const acknowledged = (overrides: Partial<AgentHeartbeatRun> = {}) => acknowledgedRun(overrides);

  it("suppresses a timer tick whose every source is at or behind the acknowledged cursors", async () => {
    const h = createHarness({
      unreadTotal: 0,
      priorRuns: [acknowledged()],
      roomEntries: [{ id: "room-entry-1" }],
      taskComments: [],
      assignedTasks: [{ id: TASK_ID, column: "in-progress", assignedAgentId: AGENT_ID }],
    });

    expect(await h.monitor.decideTimerWake(h.agent)).toEqual({ suppress: true, reason: "no-fresher-signal" });
  });

  it("dispatches on a real unread message — the legitimate wake-on-message must survive", async () => {
    const h = createHarness({ unreadTotal: 1, priorRuns: [acknowledged()] });

    expect(await h.monitor.decideTimerWake(h.agent)).toMatchObject({ suppress: false });
  });

  it("dispatches on a room entry the acknowledged run never surfaced", async () => {
    const h = createHarness({
      unreadTotal: 0,
      priorRuns: [acknowledged()],
      roomEntries: [{ id: "room-entry-1" }, { id: "room-entry-2" }],
    });

    expect(await h.monitor.decideTimerWake(h.agent)).toMatchObject({ suppress: false });
  });

  it("dispatches on a task comment the acknowledged run never surfaced", async () => {
    const h = createHarness({
      unreadTotal: 0,
      priorRuns: [acknowledged()],
      taskComments: [{ id: "comment-new" }],
    });

    expect(await h.monitor.decideTimerWake(h.agent)).toMatchObject({ suppress: false });
  });

  it("dispatches when the assigned card's state moved (failed → needs-replan → blocked bounces)", async () => {
    const h = createHarness({
      unreadTotal: 0,
      priorRuns: [acknowledged()],
      assignedTasks: [{ id: TASK_ID, column: "needs-replan", assignedAgentId: AGENT_ID }],
    });

    expect(await h.monitor.decideTimerWake(h.agent)).toMatchObject({ suppress: false });
  });

  it("dispatches when the auto-claim candidate set changes for a no-task agent", async () => {
    const h = createHarness({
      unreadTotal: 0,
      priorRuns: [
        acknowledged({
          resultJson: {
            heartbeatDoneAccepted: true,
            wakeCursor: {
              consumedMessageIds: [],
              roomEntryIds: [],
              surfacedCommentIds: [],
              // The same board the no-task agent now stands on; only the candidate set may move.
              boardState: {
                assignedTaskId: null,
                assignedTaskState: null,
                assignedRows: [],
                autoClaimCandidates: [],
              },
            },
          },
        }),
      ],
      agent: baseAgent({ taskId: undefined }),
      assignedTasks: [],
      boardTasks: [
        {
          id: "FN-777",
          title: "Claimable follow-up",
          description: "ready for pickup",
          prompt: "",
          steps: [],
          // The queue column an auto-claim candidate must sit in to be runnable (default IR roles).
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: "2026-10-12T00:00:00.000Z",
          updatedAt: "2026-10-12T00:00:00.000Z",
          columnMovedAt: new Date().toISOString(),
        },
      ],
    });

    expect(await h.monitor.decideTimerWake(h.agent)).toMatchObject({ suppress: false });
  });

  it("dispatches when no run record carries a cursor (first tick after boot or upgrade)", async () => {
    const h = createHarness({ unreadTotal: 0, priorRuns: [] });

    expect(await h.monitor.decideTimerWake(h.agent)).toMatchObject({ suppress: false });
  });

  it("dispatches when the newest run's cursor shape is not understood", async () => {
    const h = createHarness({
      unreadTotal: 0,
      priorRuns: [acknowledged({ resultJson: { heartbeatDoneAccepted: true, wakeCursor: "unexpected" } })],
    });

    expect(await h.monitor.decideTimerWake(h.agent)).toMatchObject({ suppress: false });
  });

  it("dispatches when the newest run failed — a failure is a reason to retry, not to sleep", async () => {
    const h = createHarness({ unreadTotal: 0, priorRuns: [acknowledged({ status: "failed" })] });

    expect(await h.monitor.decideTimerWake(h.agent)).toMatchObject({ suppress: false });
  });

  it("dispatches when the newest run completed without an accepted fn_heartbeat_done", async () => {
    const h = createHarness({
      unreadTotal: 0,
      priorRuns: [acknowledged({ resultJson: { summary: "ended without the terminal tool" } })],
    });

    expect(await h.monitor.decideTimerWake(h.agent)).toMatchObject({ suppress: false });
  });

  it("never suppresses a manual or ping wake", async () => {
    const h = createHarness({ unreadTotal: 0, priorRuns: [acknowledged()] });

    expect(await h.monitor.decideTimerWake(h.agent, { triggerDetail: "manual" })).toMatchObject({ suppress: false });
    expect(await h.monitor.decideTimerWake(h.agent, { triggerDetail: "ping" })).toMatchObject({ suppress: false });
  });

  it("never suppresses an assignment wake", async () => {
    const h = createHarness({ unreadTotal: 0, priorRuns: [acknowledged()] });

    expect(await h.monitor.decideTimerWake(h.agent, { source: "assignment" })).toMatchObject({ suppress: false });
  });

  it("keeps the budget observability run record: an over-budget agent is still dispatched", async () => {
    const h = createHarness({
      unreadTotal: 0,
      priorRuns: [acknowledged()],
      budget: createBudgetStatus({ isOverBudget: true }),
    });

    expect(await h.monitor.decideTimerWake(h.agent)).toMatchObject({ suppress: false });
  });

  it("keeps the budget-threshold observability run record on the timer path", async () => {
    const h = createHarness({
      unreadTotal: 0,
      priorRuns: [acknowledged()],
      budget: createBudgetStatus({ isOverThreshold: true }),
    });

    expect(await h.monitor.decideTimerWake(h.agent)).toMatchObject({ suppress: false });
  });

  it("dispatches and fails loud when the signal probe cannot read the store", async () => {
    const h = createHarness({ unreadTotal: 0, priorRuns: [acknowledged()] });
    h.messageStore.getMailbox.mockRejectedValue(new Error("inbox unreadable"));

    expect(await h.monitor.decideTimerWake(h.agent)).toMatchObject({ suppress: false });
    expect(vi.mocked(heartbeatLog.warn)).toHaveBeenCalledWith(expect.stringContaining("wake-signal-probe-failed"));
  });
});

describe("(A) the scheduler spends nothing on a suppressed timer tick", () => {
  function schedulerFor(decide: (agent: Agent) => Promise<{ suppress: boolean; reason?: string }>) {
    const agent = baseAgent();
    const store = {
      getAgent: vi.fn().mockResolvedValue(agent),
      getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    } as unknown as AgentStore;
    const callback = vi.fn().mockResolvedValue(undefined);
    const scheduler = new HeartbeatTriggerScheduler(store, callback, undefined, {
      shouldSuppressTimerWake: decide,
    });
    // The tick under test is invoked directly; only the scheduler's running flag gates it.
    (scheduler as unknown as { running: boolean }).running = true;
    return { scheduler, callback, store };
  }

  it("does not dispatch and records no run when the decision suppresses", async () => {
    const { scheduler, callback } = schedulerFor(async () => ({ suppress: true, reason: "no-fresher-signal" }));

    await (scheduler as unknown as { onTimerTick: (id: string, ms: number) => Promise<void> })
      .onTimerTick(AGENT_ID, 30_000);

    expect(callback).not.toHaveBeenCalled();
    expect(vi.mocked(heartbeatLog.log)).toHaveBeenCalledWith(
      expect.stringContaining("timer-heartbeat-suppressed"),
    );
  });

  it("dispatches normally when the decision allows the tick", async () => {
    const { scheduler, callback } = schedulerFor(async () => ({ suppress: false }));

    await (scheduler as unknown as { onTimerTick: (id: string, ms: number) => Promise<void> })
      .onTimerTick(AGENT_ID, 30_000);

    expect(callback).toHaveBeenCalledWith(AGENT_ID, "timer", expect.objectContaining({ triggerDetail: "scheduled" }));
  });

  it("dispatches when the suppression probe itself throws", async () => {
    const { scheduler, callback } = schedulerFor(async () => {
      throw new Error("probe exploded");
    });

    await (scheduler as unknown as { onTimerTick: (id: string, ms: number) => Promise<void> })
      .onTimerTick(AGENT_ID, 30_000);

    expect(callback).toHaveBeenCalled();
  });
});

describe("(A)+(B) no re-derivable duplicate of the fixed mechanisms remains", () => {
  const source = readFileSync(new URL("../agent-heartbeat.ts", import.meta.url), "utf8");

  it("no heartbeat path blanket-retires an inbox any more", () => {
    expect(/markAllAsRead\(agentId,\s*"agent"\)/.test(source)).toBe(false);
  });

  it("no wake-delta renders a preview length as a count", () => {
    expect(/pending messages: \$\{pendingMessages\.length\}/.test(source)).toBe(false);
    expect(/inbox snapshot: \$\{pendingMessages\.length\}/.test(source)).toBe(false);
  });

  it("the wake sources are read through one shared module, not re-derived per path", () => {
    expect(/from "\.\/heartbeat-wake-signals\.js"/.test(source)).toBe(true);
  });
});
