import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import type { Agent, AgentHeartbeatRun, AgentStore, TaskStore } from "@fusion/core";

vi.mock("../logger.js", async () => {
  const { formatError } = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return {
    createLogger: vi.fn(() => ({
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    heartbeatLog: {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    formatError,
  };
});

// The queued recovery wake reaches session creation only when it is allowed to fire. Mocking the
// model runtime keeps a red (pre-fix) run proving the wake fired without spawning anything real.
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: any) => {
    await session.prompt("prompt");
  }),
}));

vi.mock("../worktree/worktree-acquisition.js", () => ({
  acquireTaskWorktree: vi.fn(),
}));

import { createFnAgent } from "../pi.js";
import { heartbeatLog } from "../logger.js";

const AGENT_ID = "agent-001";
const HEARTBEAT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;
// The existing unresponsive-recovery window: a tick must go silent for 2x the timeout.
const RECOVERY_WINDOW_MS = 2 * HEARTBEAT_TIMEOUT_MS;
// Aligned to the poll interval so fake-timer polls land on exact multiples.
const T0 = Math.floor(Date.UTC(2026, 0, 1, 0, 0, 0) / POLL_INTERVAL_MS) * POLL_INTERVAL_MS;

const iso = (ms: number): string => new Date(ms).toISOString();
const log = heartbeatLog as unknown as Record<string, ReturnType<typeof vi.fn>>;
const warned = (): string[] => log.warn.mock.calls.map((call) => String(call[0]));
const mockedCreateFnAgent = vi.mocked(createFnAgent);

type AgentRow = Record<string, unknown>;
type BackoffReader = {
  getRecoveryBackoff?: (agentId: string) => { attempts: number; backoffUntilMs: number } | undefined;
};
const readBackoff = (monitor: HeartbeatMonitor) =>
  (monitor as unknown as BackoffReader).getRecoveryBackoff?.(AGENT_ID);

function runRecord(overrides: Partial<AgentHeartbeatRun> = {}): AgentHeartbeatRun {
  return {
    id: "run-stuck",
    agentId: AGENT_ID,
    startedAt: iso(T0),
    endedAt: null,
    trigger: null,
    status: "active",
    heartbeatNumber: 1,
    ...overrides,
  } as AgentHeartbeatRun;
}

/** A clean completion: `status: "completed"` with a non-null `endedAt` (the AgentHeartbeatRun contract). */
function cleanCompletion(overrides: Partial<AgentHeartbeatRun> = {}): AgentHeartbeatRun {
  return runRecord({
    id: "run-clean",
    startedAt: iso(T0 + 6_000),
    endedAt: iso(T0 + 8_000),
    status: "completed",
    ...overrides,
  });
}

function createAgentRow(overrides: AgentRow = {}): AgentRow {
  return {
    id: AGENT_ID,
    name: "Test Agent",
    role: "executor",
    state: "running",
    runtimeConfig: { enabled: false },
    ...overrides,
  };
}

/**
 * Store double whose agent row is mutable, so pause/resume transitions behave like the real
 * store (`pauseAgent`/`resumeAgent` read back the state they just wrote).
 */
function createMockStore(agentRow: AgentRow) {
  return {
    getAgent: vi.fn(async () => ({ ...agentRow })),
    getCachedAgent: vi.fn().mockReturnValue(undefined),
    updateAgentState: vi.fn(async (_agentId: string, state: string) => {
      agentRow.state = state;
      return { ...agentRow };
    }),
    updateAgent: vi.fn(async (_agentId: string, patch: AgentRow) => {
      Object.assign(agentRow, patch);
      return { ...agentRow };
    }),
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    getRecentRuns: vi.fn().mockResolvedValue([]),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    getRunDetail: vi.fn(async (_agentId: string, runId: string) => runRecord({ id: runId })),
    saveRun: vi.fn().mockResolvedValue(undefined),
    startHeartbeatRun: vi.fn().mockResolvedValue(runRecord({ id: "run-new" })),
    endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
    getBudgetStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockTaskStore() {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getTasksByAssignedAgent: vi.fn().mockResolvedValue([]),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function createSession() {
  return {
    dispose: vi.fn(),
    abort: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    model: { provider: "mock", id: "mock-model" },
  };
}

/**
 * STAS-308: `unresponsive-recovery` re-wakes agents that already proved they are alive. The durable
 * proof is a newer run that closed `status: "completed"`, so recovery must read run history and stand
 * down instead of burning a fresh session on a zero-delta wake.
 */
describe("unresponsive-recovery completion-freshness gate", () => {
  let agentRow: AgentRow;
  let store: ReturnType<typeof createMockStore>;
  let taskStore: ReturnType<typeof createMockTaskStore>;
  let monitor: HeartbeatMonitor;

  function buildMonitor(options: Record<string, unknown> = {}) {
    return new HeartbeatMonitor({
      store: store as unknown as AgentStore,
      taskStore: taskStore as unknown as TaskStore,
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      ...options,
    });
  }

  /** Advance past the recovery window so the stale tick trips `checkMissedHeartbeats`. */
  async function reachRecoveryWindow(): Promise<void> {
    await vi.advanceTimersByTimeAsync(RECOVERY_WINDOW_MS + POLL_INTERVAL_MS);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.clearAllMocks();
    agentRow = createAgentRow();
    store = createMockStore(agentRow);
    taskStore = createMockTaskStore();
  });

  afterEach(() => {
    monitor?.stop();
    vi.useRealTimers();
  });

  describe("episode start", () => {
    it("cancels the recovery episode when a newer run closed completed, with no side effect at all", async () => {
      // The stuck tick is still open, but the agent has since closed a later tick cleanly.
      store.getRecentRuns.mockResolvedValue([
        runRecord(),
        cleanCompletion({ id: "run-clean", startedAt: iso(T0 + 6_000), endedAt: iso(T0 + 8_000) }),
      ]);
      const session = createSession();
      monitor = buildMonitor();
      monitor.start();
      monitor.trackAgent(AGENT_ID, session as never, "run-stuck");

      await reachRecoveryWindow();

      // Only the hung session is disposed. Nothing is terminated, paused, or resumed, and no
      // session is opened for a wake that will never run.
      expect(session.dispose).toHaveBeenCalledTimes(1);
      expect(store.saveRun).not.toHaveBeenCalled();
      expect(store.updateAgentState).not.toHaveBeenCalled();
      expect(store.updateAgent).not.toHaveBeenCalled();
      expect(store.startHeartbeatRun).not.toHaveBeenCalled();
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
      expect(agentRow.state).toBe("running");
      // The stale tracked entry is dropped so the poll loop stops re-evaluating it.
      expect(monitor.getTrackedAgents()).not.toContain(AGENT_ID);
      // The cancellation is auditable: operator-visible log plus a durable run-audit record.
      expect(warned().some((message) => message.includes(`Recovery cancelled for ${AGENT_ID}`))).toBe(true);
      expect(warned().some((message) => message.includes("run-clean"))).toBe(true);
      expect(taskStore.recordRunAuditEvent).toHaveBeenCalledTimes(1);
      const audit = taskStore.recordRunAuditEvent.mock.calls[0][0];
      expect(audit.mutationType).toBe("agent:unresponsive-recovery-cancelled");
      expect(audit.metadata).toMatchObject({
        agentId: AGENT_ID,
        stuckRunId: "run-stuck",
        completingRunId: "run-clean",
        reason: "episode-start",
      });
    });

    it("still recovers when the run history holds no completed run at all", async () => {
      store.getRecentRuns.mockResolvedValue([runRecord()]);
      const session = createSession();
      monitor = buildMonitor();
      monitor.start();
      monitor.trackAgent(AGENT_ID, session as never, "run-stuck");

      await reachRecoveryWindow();

      expect(session.dispose).toHaveBeenCalledTimes(1);
      expect(store.updateAgentState).toHaveBeenCalledWith(AGENT_ID, "paused");
      expect(store.updateAgentState).toHaveBeenCalledWith(AGENT_ID, "active");
      expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalled();
    });

    it("still recovers when the only completed run predates the stuck tick", async () => {
      store.getRecentRuns.mockResolvedValue([
        runRecord(),
        cleanCompletion({ id: "run-old", startedAt: iso(T0 - 20_000), endedAt: iso(T0 - 10_000) }),
      ]);
      const session = createSession();
      monitor = buildMonitor();
      monitor.start();
      monitor.trackAgent(AGENT_ID, session as never, "run-stuck");

      await reachRecoveryWindow();

      expect(session.dispose).toHaveBeenCalledTimes(1);
      expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalled();
    });

    it("does not mistake its own terminated or failed run records for proof of life", async () => {
      // Earlier recovery episodes wrote these; neither proves the agent is alive.
      store.getRecentRuns.mockResolvedValue([
        runRecord(),
        runRecord({ id: "run-prev-recovery", status: "terminated", startedAt: iso(T0 + 500), endedAt: iso(T0 + 9_000) }),
        runRecord({ id: "run-prev-failed", status: "failed", startedAt: iso(T0 + 600), endedAt: iso(T0 + 9_100) }),
      ]);
      const session = createSession();
      monitor = buildMonitor();
      monitor.start();
      monitor.trackAgent(AGENT_ID, session as never, "run-stuck");

      await reachRecoveryWindow();

      expect(session.dispose).toHaveBeenCalledTimes(1);
      expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalled();
    });

    it("recovers anyway when the run-history read fails", async () => {
      store.getRecentRuns.mockRejectedValue(new Error("db unreachable"));
      const session = createSession();
      monitor = buildMonitor();
      monitor.start();
      monitor.trackAgent(AGENT_ID, session as never, "run-stuck");

      await reachRecoveryWindow();

      expect(session.dispose).toHaveBeenCalledTimes(1);
      expect(store.updateAgentState).toHaveBeenCalledWith(AGENT_ID, "paused");
    });
  });

  describe("queued wake fires after the per-agent start lock is released", () => {
    beforeEach(() => {
      agentRow.runtimeConfig = { enabled: true };
    });

    it("cancels the queued recovery wake once a clean completion lands while it waits", async () => {
      // Reproduction of the STAS-270 incident: the wake is requested while the agent looks dead,
      // queues behind the per-agent start lock, and the agent keeps completing ticks meanwhile.
      let recentRuns: AgentHeartbeatRun[] = [runRecord()];
      store.getRecentRuns.mockImplementation(async () => recentRuns);

      const stuckSession = createSession();
      monitor = buildMonitor({ rootDir: "/tmp" });

      // Something else holds the per-agent start lock, so the recovery wake cannot run yet.
      let releaseLock!: () => void;
      const hold = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const holder = monitor.withAgentStartLock(AGENT_ID, async () => hold);

      monitor.start();
      monitor.trackAgent(AGENT_ID, stuckSession as never, "run-stuck");
      await reachRecoveryWindow();

      // The episode itself was legitimate: no proof of life existed at decision time.
      expect(stuckSession.dispose).toHaveBeenCalledTimes(1);
      expect(store.startHeartbeatRun).not.toHaveBeenCalled();

      // The agent then closes a later tick cleanly while the wake is still queued.
      recentRuns = [
        runRecord({ status: "terminated", endedAt: iso(T0 + RECOVERY_WINDOW_MS) }),
        cleanCompletion({ id: "run-clean-later" }),
      ];
      releaseLock();
      await holder;
      // Queuing a no-op behind the wake proves the whole queued chain has drained.
      await monitor.withAgentStartLock(AGENT_ID, async () => {});

      expect(store.startHeartbeatRun).not.toHaveBeenCalled();
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
      expect(warned().some((message) => message.includes(`Recovery wake cancelled for ${AGENT_ID}`))).toBe(true);
      const auditReasons = taskStore.recordRunAuditEvent.mock.calls.map((call) => call[0].metadata?.reason);
      expect(auditReasons).toContain("queued-wake-fire-time");
    });

    it("still fires the queued recovery wake when no clean completion lands while it waits", async () => {
      store.getRecentRuns.mockResolvedValue([runRecord()]);
      mockedCreateFnAgent.mockResolvedValue(createSession() as never);

      const stuckSession = createSession();
      monitor = buildMonitor({ rootDir: "/tmp" });

      let releaseLock!: () => void;
      const hold = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const holder = monitor.withAgentStartLock(AGENT_ID, async () => hold);

      monitor.start();
      monitor.trackAgent(AGENT_ID, stuckSession as never, "run-stuck");
      await reachRecoveryWindow();
      releaseLock();
      await holder;
      await monitor.withAgentStartLock(AGENT_ID, async () => {});

      expect(store.startHeartbeatRun).toHaveBeenCalledTimes(1);
    });
  });

  describe("per-agent recovery backoff", () => {
    it("spaces repeated recovery episodes and doubles the cooldown per repeat", async () => {
      // No proof of life at any point: this is the genuinely stuck agent AC4 protects.
      store.getRecentRuns.mockResolvedValue([runRecord()]);
      const firstSession = createSession();
      monitor = buildMonitor();
      monitor.start();
      monitor.trackAgent(AGENT_ID, firstSession as never, "run-stuck");

      await reachRecoveryWindow();
      expect(firstSession.dispose).toHaveBeenCalledTimes(1);

      const first = readBackoff(monitor);
      expect(first).toBeTruthy();
      expect(first!.attempts).toBe(1);
      const firstCooldown = first!.backoffUntilMs - Date.now();
      // The cooldown starts at 2x the recovery window.
      expect(firstCooldown).toBeLessThanOrEqual(2 * RECOVERY_WINDOW_MS);
      expect(firstCooldown).toBeGreaterThan(2 * RECOVERY_WINDOW_MS - 3 * POLL_INTERVAL_MS);

      // A later wake re-tracks the agent and it hangs again — still inside the cooldown.
      const secondSession = createSession();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      monitor.trackAgent(AGENT_ID, secondSession as never, "run-stuck-2");
      await vi.advanceTimersByTimeAsync(RECOVERY_WINDOW_MS + 4 * POLL_INTERVAL_MS);

      expect(secondSession.dispose).not.toHaveBeenCalled();

      // Past the cooldown the episode runs again, and the next cooldown is doubled.
      await vi.advanceTimersByTimeAsync(RECOVERY_WINDOW_MS + 3 * POLL_INTERVAL_MS);
      expect(secondSession.dispose).toHaveBeenCalledTimes(1);

      const second = readBackoff(monitor);
      expect(second!.attempts).toBe(2);
      expect(second!.backoffUntilMs - Date.now()).toBeGreaterThan(firstCooldown * 1.5);
    });
  });
});
