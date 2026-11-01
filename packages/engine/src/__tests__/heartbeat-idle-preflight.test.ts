/*
FNXC:HeartbeatIdlePreflight 2026-11-01-12:45 (RUFU-268):
AN ADMISSIBLE IDLE TICK COSTS ONE QUESTION. EVERY OTHER TICK COSTS WHAT IT ALWAYS COST.

The claim has two halves, and the second is the one that keeps this change mergable:

1. A board-candidate delta on a timer tick, for an agent that began the run unassigned, is answered by a
   tool-less turn whose head is a constant. `NOOP` completes the run with the SAME acknowledgement and
   wake cursor the full path writes — it goes through the same single writer — and advances the ladder.
   No heartbeat session is created, which is the entire saving.
2. Every other outcome is the old behaviour: `WORK`, an ambiguous reply, a provider error, a tick that
   was not classified as candidate-only, a manual wake, an agent with an assignment. Each of those opens
   the full session it opened before this file existed. A failure mode where the cheap turn is the reason
   real work got skipped is the one this suite exists to make impossible.

The session seam is mocked at `createResolvedAgentSession`, so the assertions count SESSIONS: "the agent
was not charged a briefing" is observable as "this run created exactly one session, and its head was the
compact constant", which is a fact about cost rather than about a log line.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import {
  IDLE_PREFLIGHT_SYSTEM_PROMPT,
  buildIdlePreflightRequest,
  clampIdlePreflightCandidateIds,
  parseIdlePreflightVerdict,
} from "../heartbeat-idle-preflight.js";
import { createAcknowledgedHeartbeatRun, createBudgetStatus, createIdleLadderAgent } from "./heartbeat-test-helpers.js";
import type { Agent, AgentHeartbeatRun, AgentStore, TaskStore } from "@fusion/core";

vi.mock("../logger.js", async () => {
  const { formatMockError } = await import("./heartbeat-test-helpers.js");
  const quietLogger = () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() });
  return { createLogger: vi.fn(() => quietLogger()), heartbeatLog: quietLogger(), formatError: formatMockError };
});

/*
pi.js is mocked because the compact turn reaches the model through `promptWithFallback`, and the mocked
`promptWithFallback` drives the fake session's `prompt()` — which is where the scripted answer is emitted.
*/
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: { prompt?: (text: string) => Promise<void> }, prompt: string) => {
    await session?.prompt?.(prompt);
  }),
}));

vi.mock("../agents/agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/agent-session-helpers.js")>();
  return { ...actual, createResolvedAgentSession: vi.fn() };
});

/*
The board probe is mocked at its module boundary (same convention as `heartbeat-idle-backoff.test.ts`):
the candidate SET is the input this suite varies, while the store walk behind it belongs elsewhere.
`classifyFresherWakeSignal` stays REAL everywhere — the admissibility decision is about that classification.
*/
vi.mock("../heartbeat-wake-signals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../heartbeat-wake-signals.js")>();
  return { ...actual, collectBoardSignal: vi.fn() };
});

import { collectBoardSignal } from "../heartbeat-wake-signals.js";
import { createResolvedAgentSession } from "../agents/agent-session-helpers.js";

const mockedCollectBoardSignal = vi.mocked(collectBoardSignal);
const mockedCreateResolvedSession = vi.mocked(createResolvedAgentSession);

const AGENT_ID = "agent-idle-1";

interface ScriptedSession {
  prompt: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  state: Record<string, unknown>;
}

/**
 * A session that answers the compact question with `answer`, delivered as a terminal assistant message —
 * the same event shape the shared assistant-text capture reads, so the pre-flight's capture seam is
 * exercised rather than bypassed. A script of `null` answers with nothing, which must read as
 * `unavailable` and take the full path.
 */
function scriptedSession(answer: string | null): ScriptedSession {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    prompt: vi.fn(async () => {
      if (answer === null) return;
      for (const listener of listeners) {
        listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } });
      }
    }),
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => { listeners.length = 0; };
    }),
    dispose: vi.fn(),
    state: {},
  };
}

interface PreflightHarness {
  monitor: HeartbeatMonitor;
  agent: Agent;
  store: AgentStore;
  updates: Record<string, unknown>[];
  audit: { mutationType: string; metadata?: Record<string, unknown> }[];
  /** One entry per session the run created, in creation order — the cost this suite counts. */
  sessions: Array<{ systemPrompt: string; session: ScriptedSession }>;
  runIdleHeartbeat: (options?: { source?: "timer" | "on_demand"; fresherSignal?: string; candidates?: string[] }) => Promise<AgentHeartbeatRun>;
}

function preflightHarness(options: {
  runtimeConfig?: Record<string, unknown>;
  candidates?: string[];
  /** `"throw"` models a provider failure; a string is the scripted answer. */
  answer?: string | null | "throw";
  secondAnswer?: string | null;
} = {}): PreflightHarness {
  const agent = createIdleLadderAgent(options.runtimeConfig ?? {});
  const updates: Record<string, unknown>[] = [];
  const audit: { mutationType: string; metadata?: Record<string, unknown> }[] = [];
  const sessions: Array<{ systemPrompt: string; session: ScriptedSession }> = [];

  mockedCollectBoardSignal.mockResolvedValue({
    assignedTaskId: null,
    assignedTaskState: null,
    assignedRows: [],
    autoClaimCandidates: options.candidates ?? ["FN-900"],
    steeringCommentIds: [],
  } as never);

  let sessionIndex = 0;
  mockedCreateResolvedSession.mockImplementation(async (sessionOptions: { systemPrompt?: string }) => {
    const answer = sessionIndex === 0 ? options.answer ?? "NOOP" : options.secondAnswer ?? null;
    sessionIndex += 1;
    const session = scriptedSession(answer === "throw" ? null : answer);
    if (answer === "throw") session.prompt.mockRejectedValue(new Error("provider unavailable"));
    sessions.push({ systemPrompt: String(sessionOptions?.systemPrompt ?? ""), session });
    return { session, sessionFile: undefined, runtimeId: "mock", wasConfigured: true };
  });

  const savedRuns = new Map<string, AgentHeartbeatRun>();
  const store = {
    getAgent: vi.fn().mockResolvedValue(agent),
    updateAgent: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
      return agent;
    }),
    updateAgentState: vi.fn().mockResolvedValue(undefined),
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    assignTask: vi.fn().mockResolvedValue(agent),
    claimTaskForAgent: vi.fn().mockResolvedValue({ ok: false, reason: "task_not_found" }),
    startHeartbeatRun: vi.fn(async (_agentId: string, initial = {}) => {
      const run = { id: "run-1", agentId: AGENT_ID, startedAt: new Date().toISOString(), endedAt: null, status: "active", ...initial } as unknown as AgentHeartbeatRun;
      savedRuns.set(run.id, run);
      return run;
    }),
    saveRun: vi.fn(async (run: AgentHeartbeatRun) => { savedRuns.set(run.id, run); }),
    getRunDetail: vi.fn(async (_agentId: string, runId: string) => savedRuns.get(runId) ?? null),
    endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    getRecentRuns: vi.fn().mockResolvedValue([createAcknowledgedHeartbeatRun([])]),
    getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus({ isOverBudget: false, isOverThreshold: false })),
    getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
    getCachedAgent: vi.fn().mockReturnValue(null),
    appendRunLog: vi.fn().mockResolvedValue(undefined),
    getRatingSummary: vi.fn().mockResolvedValue(undefined),
    getLastBlockedState: vi.fn().mockResolvedValue(null),
    setLastBlockedState: vi.fn().mockResolvedValue(undefined),
    clearLastBlockedState: vi.fn().mockResolvedValue(undefined),
    syncExecutionTaskLink: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentStore;

  const taskStore = {
    getSettings: vi.fn().mockResolvedValue({}),
    getTask: vi.fn().mockResolvedValue(null),
    listTasks: vi.fn().mockResolvedValue([]),
    getTasksByAssignedAgent: vi.fn().mockResolvedValue([]),
    selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    logEntry: vi.fn().mockResolvedValue({}),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn(async (event: { mutationType: string; metadata?: Record<string, unknown> }) => { audit.push(event); }),
  } as unknown as TaskStore;

  const monitor = new HeartbeatMonitor({
    store,
    agentStore: store,
    taskStore,
    rootDir: process.cwd(),
    snapshotManager: { getSnapshot: vi.fn().mockResolvedValue({ tasks: [] }) } as never,
  } as never);

  return {
    monitor,
    agent,
    store,
    updates,
    audit,
    sessions,
    runIdleHeartbeat: (runOptions = {}) => monitor.executeHeartbeat({
      agentId: AGENT_ID,
      source: runOptions.source ?? "timer",
      fresherSignal: runOptions.fresherSignal as never,
    }),
  };
}

describe("the idle pre-flight's pure turn", () => {
  it("keeps the head byte-identical and puts the ids on the tail", () => {
    const first = buildIdlePreflightRequest(["FN-10", "FN-2"]);
    const second = buildIdlePreflightRequest(["FN-10", "FN-2"]);
    // `toBe`, not `toEqual`: the provider cache reuses this prefix only while the bytes do not move.
    expect(first).toBe(second);
    expect(first).toContain("FN-10");
    // Sorted, so a board that merely reshuffled cannot change the request's bytes and break its own cache.
    expect(first.indexOf("FN-10")).toBeLessThan(first.indexOf("FN-2"));
    expect(IDLE_PREFLIGHT_SYSTEM_PROMPT).not.toContain("FN-");
  });

  it("stays inside the compact budget however many candidates the board offers", () => {
    const many = Array.from({ length: 500 }, (_unused, index) => `FN-${index}`);
    const request = buildIdlePreflightRequest(many);
    expect(request.length).toBeLessThan(5_000);
    expect(request).not.toContain("FN-499");
    // Duplicates collapse: 60 ids of which half are repeats is not 60 candidates.
    expect(clampIdlePreflightCandidateIds(["FN-1", "FN-1", "FN-2"])).toEqual(["FN-1", "FN-2"]);
  });

  it("reads only an exact token as a verdict", () => {
    expect(parseIdlePreflightVerdict("NOOP")).toBe("noop");
    expect(parseIdlePreflightVerdict(" noop \n")).toBe("noop");
    expect(parseIdlePreflightVerdict("WORK")).toBe("work");
    // Everything below falls through to the full path: a word inside a sentence is not an answer, a
    // reply that names both tokens is not an answer, and neither is silence.
    expect(parseIdlePreflightVerdict("I think this is a NOOP for now.")).toBe("unavailable");
    expect(parseIdlePreflightVerdict("WORK\nNOOP")).toBe("unavailable");
    expect(parseIdlePreflightVerdict("")).toBe("unavailable");
    expect(parseIdlePreflightVerdict(undefined)).toBe("unavailable");
    expect(parseIdlePreflightVerdict("NO-OPT")).toBe("unavailable");
  });
});

describe("the idle pre-flight's session turn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("completes an admissible idle tick with the same acknowledgement the full path writes, and no session", async () => {
    const h = preflightHarness({ answer: "NOOP", candidates: ["FN-900"] });

    const run = await h.runIdleHeartbeat({ fresherSignal: "board-candidates" });

    expect(run.status).toBe("completed");
    // The acknowledgement is not a new shape: `heartbeatDoneAccepted` + `wakeCursor` are exactly what the
    // gate reads on the next tick, so a NOOP tick is provably as well-attested as a full run.
    expect(run.resultJson).toEqual(expect.objectContaining({
      reason: "idle_preflight_noop",
      heartbeatDoneAccepted: true,
    }));
    expect((run.resultJson as { wakeCursor?: { boardState?: { autoClaimCandidates?: string[] } } }).wakeCursor?.boardState?.autoClaimCandidates)
      .toEqual(["FN-900"]);

    // ONE session, and it was the compact one: no briefing was ever assembled.
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.systemPrompt).toBe(IDLE_PREFLIGHT_SYSTEM_PROMPT);
    const request = h.sessions[0]!.session.prompt.mock.calls[0]![0] as string;
    expect(request.length).toBeLessThan(5_000);
    expect(request).toContain("FN-900");

    // The ladder advanced, which is what the answered question bought.
    const runtimeConfig = h.updates[0]?.runtimeConfig as Record<string, unknown> | undefined;
    expect(runtimeConfig?.heartbeatIdleStreak).toBe(1);
    expect(h.audit.map((event) => event.mutationType)).toContain("agent:heartbeat-idle-ladder");
  });

  it("asks about the ids the board offers, never a board dump or an identity block", async () => {
    const h = preflightHarness({ answer: "WORK", secondAnswer: null });
    await h.runIdleHeartbeat({ fresherSignal: "board-candidates" });

    const request = h.sessions[0]!.session.prompt.mock.calls[0]![0] as string;
    expect(request.toLowerCase()).not.toContain("soul");
    expect(request).not.toContain(h.agent.soul as string);
    expect(request.split("\n").length).toBeLessThan(12);
  });

  it("spends the full session when the answer is WORK and clears the ladder it was idling on", async () => {
    const h = preflightHarness({
      runtimeConfig: { heartbeatIdleStreak: 6, heartbeatLastNoWorkAt: new Date().toISOString() },
      answer: "WORK",
    });

    await h.runIdleHeartbeat({ fresherSignal: "board-candidates" });

    // Two sessions: the question, then the briefing the agent would always have paid for.
    expect(h.sessions.length).toBeGreaterThan(1);
    expect(h.sessions[0]!.systemPrompt).toBe(IDLE_PREFLIGHT_SYSTEM_PROMPT);
    expect(h.sessions[1]!.systemPrompt).not.toBe(IDLE_PREFLIGHT_SYSTEM_PROMPT);

    // Fresh work means the agent is not idling: the ladder is cleared before the full run proceeds.
    const runtimeConfig = h.updates[0]?.runtimeConfig as Record<string, unknown> | undefined;
    expect(runtimeConfig).toBeDefined();
    expect(runtimeConfig).not.toHaveProperty("heartbeatIdleStreak");
    expect(runtimeConfig).not.toHaveProperty("heartbeatLastNoWorkAt");
  });

  it("spends the full session on an answer it cannot read", async () => {
    const h = preflightHarness({ answer: "Hmm, maybe something needs me?" });
    await h.runIdleHeartbeat({ fresherSignal: "board-candidates" });
    expect(h.sessions.length).toBeGreaterThan(1);
    expect(h.sessions[0]!.systemPrompt).toBe(IDLE_PREFLIGHT_SYSTEM_PROMPT);
  });

  it("spends the full session when the cheap turn itself fails", async () => {
    const h = preflightHarness({ answer: "throw", secondAnswer: null });
    const run = await h.runIdleHeartbeat({ fresherSignal: "board-candidates" });
    // A provider error on the compact turn may not end the run — the full path still gets its chance.
    expect(run.resultJson).not.toEqual(expect.objectContaining({ reason: "idle_preflight_noop" }));
    expect(h.sessions.length).toBeGreaterThan(1);
  });

  it("does not attempt the cheap turn for a signal the compact question was never shown", async () => {
    for (const fresherSignal of ["messages", "room", "board-content", "board-assignment", "none", undefined]) {
      vi.clearAllMocks();
      const h = preflightHarness({ answer: "NOOP" });
      const run = await h.runIdleHeartbeat({ fresherSignal });
      expect(h.sessions).toHaveLength(1);
      expect(h.sessions[0]!.systemPrompt).not.toBe(IDLE_PREFLIGHT_SYSTEM_PROMPT);
      expect(run.resultJson).not.toEqual(expect.objectContaining({ reason: "idle_preflight_noop" }));
    }
  });

  it("does not attempt the cheap turn for a wake that was not a timer tick", async () => {
    const h = preflightHarness({ answer: "NOOP" });
    await h.runIdleHeartbeat({ source: "on_demand", fresherSignal: "board-candidates" });
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.systemPrompt).not.toBe(IDLE_PREFLIGHT_SYSTEM_PROMPT);
  });

  it("does not attempt the cheap turn for an agent that has an assignment", async () => {
    const h = preflightHarness({ answer: "NOOP" });
    // The assignment case is decided by `runStartedUnassigned`/`isNoTaskRun` before any candidate read;
    // an assigned agent's tick must look exactly like it always has.
    (h.store.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(createIdleLadderAgent({}, { taskId: "FN-901" }));
    await h.runIdleHeartbeat({ fresherSignal: "board-candidates" });
    expect(h.sessions.every((entry) => entry.systemPrompt !== IDLE_PREFLIGHT_SYSTEM_PROMPT)).toBe(true);
  });
});
