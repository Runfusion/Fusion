import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HeartbeatMonitor,
  HEARTBEAT_SYSTEM_PROMPT,
  HEARTBEAT_NO_TASK_SYSTEM_PROMPT,
  HEARTBEAT_PROCEDURE,
  HEARTBEAT_PROCEDURE_OFF,
  HEARTBEAT_NO_TASK_PROCEDURE,
  getAgentSoulWords,
} from "../agent-heartbeat.js";
import { AgentLogger } from "../agent-logger.js";
import { expectAppendAgentLog } from "./agent-log-assertions.js";
import {
  TRIAGE_HEARTBEAT_PATROL_DISABLED_INSTRUCTION,
  type AgentStore,
  type AgentHeartbeatRun,
  type TaskStore,
  type TaskDetail,
  type Agent,
  type MessageStore,
  type Message,
} from "@fusion/core";
import { createMessage, createBudgetStatus } from "./heartbeat-test-helpers.js";
vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
    formatError: formatMockError,
  };
});
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  // FNXC:EngineTestDrift 2026-07-11-22:23:
  // DefaultPiRuntime.describeModel (runtime-resolution.ts) now reaches the real
  // pi.js describeModel export on the heartbeat path. The hand-written pi.js
  // mock must surface it or vitest throws "No describeModel export is defined",
  // which cascades into createFnAgent failing and every heartbeat ending 'failed'.
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: any, prompt: string) => {
    await session.prompt(prompt);
  }),
}));
import { createFnAgent } from "../pi.js";
import { heartbeatLog } from "../logger.js";
import { acquireTaskWorktree } from "../worktree-acquisition.js";
const mockedCreateFnAgent = vi.mocked(createFnAgent);
const mockedAcquireTaskWorktree = vi.mocked(acquireTaskWorktree);

vi.mock("../worktree-acquisition.js", () => ({
  acquireTaskWorktree: vi.fn(),
}));

describe("getAgentSoulWords", () => {
  it("memoizes soul words for repeated calls", () => {
    const agent = { id: "agent-memo-1", soul: "Focus reliability automation and clarity" } as Agent;

    const first = getAgentSoulWords(agent);
    const second = getAgentSoulWords(agent);

    expect(second).toBe(first);
  });

  it("recomputes when soul changes", () => {
    const agent = { id: "agent-memo-2", soul: "Focus reliability automation" } as Agent;

    const first = getAgentSoulWords(agent);
    agent.soul = "Focus performance profiling";
    const second = getAgentSoulWords(agent);

    expect(second).not.toBe(first);
    expect(second).toContain("performance");
  });
});

describe("executeHeartbeat", () => {
  let mockTaskStore: TaskStore;
  let mockAgent: Agent;

  // Helper: create a mock session returned by createFnAgent
  function createMockAgentSession() {
    return {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(),
      model: { provider: "mock", id: "mock-model" },
    };
  }

  type MockTaskStoreOverrides = Partial<TaskStore> & {
    checkoutTask?: (taskId: string, agentId: string) => Promise<unknown>;
  };

  // Helper: create a basic mock task store
  function createMockTaskStore(overrides: MockTaskStoreOverrides = {}): TaskStore {
    return {
      getTask: vi.fn().mockResolvedValue({
        id: "FN-001",
        title: "Test Task",
        description: "Test task description",
        prompt: "# Test PROMPT.md\nSome content",
        steps: [],
        column: "todo",
        worktree: "/tmp/worktree-fn-001",
        branch: "fusion/fn-001",
        dependencies: [],
        log: [],
        attachments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as TaskDetail),
      selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
      listTasks: vi.fn().mockResolvedValue([]),
      // FNXC:WakeDeltaMultiAssign 2026-07-13-12:45:
      // executeHeartbeat loads assigned inventory for Wake Delta; default empty so existing tests stay no-op.
      getTasksByAssignedAgent: vi.fn().mockResolvedValue([]),
      createTask: vi.fn().mockResolvedValue({
        id: "FN-002",
        description: "Created task",
        dependencies: [],
        column: "triage",
      }),
      /*
      FNXC:TaskCreateDedup 2026-07-18-14:45:
      FN-8277 parent-scoped uniqueness pre-check calls findRecentTasksBySourceParentTaskId before createTask.
      Default empty candidates so heartbeat fn_task_create tool tests reach the store write.
      */
      findRecentTasksBySourceParentTaskId: vi.fn().mockResolvedValue([]),
      logEntry: vi.fn().mockResolvedValue({}),
      addComment: vi.fn().mockResolvedValue({}),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      // Document-related methods for task_document tools
      upsertTaskDocument: vi.fn().mockResolvedValue({
        id: "doc-1",
        taskId: "FN-001",
        key: "test-plan",
        content: "Test document content",
        revision: 1,
        author: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      getTaskDocument: vi.fn().mockResolvedValue({
        id: "doc-1",
        taskId: "FN-001",
        key: "test-plan",
        content: "Test document content",
        revision: 1,
        author: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      getTaskDocuments: vi.fn().mockResolvedValue([]),
      // FNXC:HeartbeatTests 2026-07-12-10:00: FN-7835's completeRun(failed) calls this.taskStore.getSettings() to resolve the error-recovery limit inside the failed-state transition block. Without this mock, the call throws TypeError, caught by the outer try-catch — so the agent is never set to "error" (it stays "running" from startRun), breaking every failed-run state-transition assertion. Placed before ...overrides so test-specific getSettings mocks still win.
      getSettings: vi.fn().mockResolvedValue({}),
      ...overrides,
    } as unknown as TaskStore;
  }

  // Helper: create a mock store that returns a specific agent
  function createStoreWithAgentForExec(agentData: Partial<Agent> = {}): AgentStore {
    mockAgent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "active",
      taskId: "FN-001",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
      ...agentData,
    } as Agent;

    // Track saved runs so getRunDetail returns the most recent state
    const savedRuns: Map<string, AgentHeartbeatRun> = new Map();

    return {
      recordHeartbeat: vi.fn().mockResolvedValue(undefined),
      updateAgentState: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
      getAgent: vi.fn().mockResolvedValue(mockAgent),
      assignTask: vi.fn().mockImplementation(async (_agentId: string, taskId: string | undefined) => {
        mockAgent.taskId = taskId;
        return mockAgent;
      }),
      claimTaskForAgent: vi.fn().mockImplementation(async (_agentId: string, _taskId: string) => ({
        ok: false,
        reason: "task_not_found",
      })),
      startHeartbeatRun: vi.fn().mockResolvedValue({
        id: "run-001",
        agentId: "agent-001",
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active",
      } as AgentHeartbeatRun),
      saveRun: vi.fn().mockImplementation(async (run: AgentHeartbeatRun) => {
        savedRuns.set(run.id, run);
      }),
      getRunDetail: vi.fn().mockImplementation(async (_agentId: string, runId: string) => {
        return savedRuns.get(runId) ?? {
          id: runId,
          agentId: "agent-001",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          status: "completed" as const,
        };
      }),
      getRatingSummary: vi.fn().mockResolvedValue(undefined),
      endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
      getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
      getCachedAgent: vi.fn().mockReturnValue(null),
      getLastBlockedState: vi.fn().mockResolvedValue(null),
      setLastBlockedState: vi.fn().mockResolvedValue(undefined),
      clearLastBlockedState: vi.fn().mockResolvedValue(undefined),
      appendRunLog: vi.fn().mockResolvedValue(undefined),
      getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
      syncExecutionTaskLink: vi.fn().mockResolvedValue(undefined),
      getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
    } as unknown as AgentStore;
  }

  beforeEach(() => {
    mockTaskStore = createMockTaskStore();
    vi.clearAllMocks();
    mockedAcquireTaskWorktree.mockResolvedValue({
      worktreePath: "/tmp/worktree-fn-001",
      branch: "fusion/fn-001",
      source: "existing",
      hydrated: false,
      isResume: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("reports health check", () => {
    it("buildReportsHealthSection returns null when agent has no reports", async () => {
      const store = createStoreWithAgentForExec();
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(result).toBeNull();
    });

    it("buildReportsHealthSection returns formatted table for healthy reports", async () => {
      const now = new Date().toISOString();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        { id: "agent-002", name: "agent-2", state: "active", taskId: "FN-100", lastHeartbeatAt: now, updatedAt: now } as Agent,
        { id: "agent-003", name: "agent-3", state: "running", taskId: "FN-101", lastHeartbeatAt: now, updatedAt: now } as Agent,
      ]);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).toContain("## Reports Health Check");
      expect(section).toContain("agent-2");
      expect(section).toContain("agent-3");
      expect(section).toContain("| Name | State | Task | Last Heartbeat | Health |");
      expect(section).toContain("healthy");
    });

    it("FN-8184: reports runtimeConfig cadence with one multiplier application and strict stale boundary", async () => {
      vi.useFakeTimers();
      const now = new Date("2026-01-01T12:00:00.000Z");
      vi.setSystemTime(now);
      const intervalMs = 10_800_000;
      const effectiveIntervalMs = 81_000_000;
      const staleThresholdMs = effectiveIntervalMs * 1.5;
      const store = createStoreWithAgentForExec();
      mockTaskStore = createMockTaskStore({ getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 7.5 }) });
      vi.mocked(store.getAgent).mockImplementation(async (agentId: string) => agentId === "agent-runtime"
        ? { id: agentId, runtimeConfig: { heartbeatIntervalMs: intervalMs } } as Agent
        : mockAgent);
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        { id: "agent-runtime", name: "Runtime Healthy", state: "active", taskId: null, lastHeartbeatAt: new Date(now.getTime() - 4.5 * 60 * 60_000).toISOString(), updatedAt: now.toISOString() } as Agent,
        { id: "agent-boundary", name: "Strict Boundary", state: "idle", taskId: null, lastHeartbeatAt: new Date(now.getTime() - staleThresholdMs).toISOString(), updatedAt: now.toISOString() } as Agent,
        { id: "agent-overdue", name: "Strict Overdue", state: "active", taskId: null, lastHeartbeatAt: new Date(now.getTime() - staleThresholdMs - 1).toISOString(), updatedAt: now.toISOString() } as Agent,
      ]);
      vi.mocked(store.getAgent).mockImplementation(async (agentId: string) => ({ id: agentId, runtimeConfig: { heartbeatIntervalMs: intervalMs } } as Agent));
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).toMatch(/\| Runtime Healthy \| active \| — \| .* \| healthy \|/);
      expect(section).toMatch(/\| Strict Boundary \| idle \| — \| .* \| healthy \|/);
      expect(section).toMatch(/\| Strict Overdue \| active \| — \| .* \| \*\*stale\*\* \|/);
      expect(heartbeatLog.log).toHaveBeenCalledWith(expect.stringContaining("intervalSource=runtimeConfig"));
    });

    it("FN-8184: getAgentHeartbeatConfig scales task-store-backed values exactly once", async () => {
      const store = createStoreWithAgentForExec();
      mockTaskStore = createMockTaskStore({ getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 7.5 }) });
      vi.mocked(store.getAgent).mockResolvedValue({
        ...mockAgent,
        runtimeConfig: { heartbeatIntervalMs: 10_800_000, heartbeatTimeoutMs: 60_000 },
      } as Agent);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await expect(monitor.getAgentHeartbeatConfig("agent-001")).resolves.toMatchObject({
        pollIntervalMs: 81_000_000,
        heartbeatTimeoutMs: 450_000,
      });
    });

    it("FN-6954: buildReportsHealthSection suppresses running state for parked task with no live proof", async () => {
      const now = new Date().toISOString();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        { id: "agent-backend", name: "Backend Engineer", state: "running", taskId: "FN-6709", lastHeartbeatAt: now, updatedAt: now } as Agent,
      ]);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);
      mockTaskStore = createMockTaskStore({
        getTask: vi.fn(async (taskId: string) => ({
          id: taskId,
          column: "todo",
          status: "queued",
          overlapBlockedBy: "FN-6827",
          blockedBy: null,
          dependencies: [],
          log: [],
          steps: [],
          attachments: [],
          createdAt: now,
          updatedAt: now,
        }) as unknown as TaskDetail),
      });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);

      expect(section).toContain("| Backend Engineer | active | FN-6709 (queued/no live run) |");
      expect(section).toContain("**stale** assignment");
      expect(section).not.toContain("| Backend Engineer | running | FN-6709 |");
    });

    it("FN-6954: buildReportsHealthSection preserves running state for parked task with fresh active run", async () => {
      const now = new Date().toISOString();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        { id: "agent-backend", name: "Backend Engineer", state: "running", taskId: "FN-6709", lastHeartbeatAt: now, updatedAt: now } as Agent,
      ]);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue({
        id: "run-live",
        agentId: "agent-backend",
        startedAt: now,
        status: "active",
      } as AgentHeartbeatRun);
      mockTaskStore = createMockTaskStore({
        getTask: vi.fn(async (taskId: string) => ({
          id: taskId,
          column: "todo",
          status: "queued",
          overlapBlockedBy: "FN-6827",
          dependencies: [],
          log: [],
          steps: [],
          attachments: [],
          createdAt: now,
          updatedAt: now,
        }) as unknown as TaskDetail),
      });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);

      expect(section).toContain("| Backend Engineer | running | FN-6709 |");
      expect(section).not.toContain("queued/no live run");
      expect(section).not.toContain("**stale** assignment");
    });

    it("buildReportsHealthSection classifies stuck agents", async () => {
      const now = Date.now();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        { id: "agent-002", name: "agent-2", state: "error", taskId: "FN-100", lastHeartbeatAt: new Date(now - 1000).toISOString(), updatedAt: new Date(now - 1000).toISOString(), lastError: "boom" } as Agent,
      ]);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp", heartbeatTimeoutMs: 60_000 });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).toContain("**stuck**");
      expect(section).toContain("Actions for Unresponsive Reports");
      expect(section).toContain("first check task-log/step progress, the active heartbeat run, and worktree/session liveness");
      expect(section).toContain("If work is live, do not stop or reassign it");
    });

    it("buildReportsHealthSection classifies stale agents", async () => {
      const now = Date.now();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        { id: "agent-003", name: "agent-3", state: "active", taskId: "FN-101", lastHeartbeatAt: new Date(now - 5 * 60 * 60 * 1000).toISOString(), updatedAt: new Date(now - 5 * 60 * 60 * 1000).toISOString() } as Agent,
      ]);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp", heartbeatTimeoutMs: 60_000 });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).toContain("**stale**");
    });

    it("buildReportsHealthSection reproduces sparse-cache false positive without persisted interval (FN-5362)", async () => {
      const now = Date.now();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getCachedAgent).mockReturnValue(null);
      vi.mocked(store.getAgent).mockResolvedValue({
        id: "agent-frontend",
      } as unknown as Agent);
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        {
          id: "agent-frontend",
          name: "Frontend Engineer",
          state: "idle",
          taskId: null,
          lastHeartbeatAt: new Date(now - 20 * 60_000).toISOString(),
          updatedAt: new Date(now - 20 * 60_000).toISOString(),
        } as unknown as Agent,
      ]);
      const monitor = new HeartbeatMonitor({
        store,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
        pollIntervalMs: 5 * 60_000,
      });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).toContain("Frontend Engineer");
      expect(section).toContain("**stale**");
    });

    it("buildReportsHealthSection uses persisted agent interval when cache is sparse (FN-5362)", async () => {
      const now = Date.now();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getCachedAgent).mockReturnValue(null);
      vi.mocked(store.getAgent).mockResolvedValue({
        id: "agent-frontend",
        runtimeConfig: { heartbeatIntervalMs: 60 * 60_000 },
      } as unknown as Agent);
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        {
          id: "agent-frontend",
          name: "Frontend Engineer",
          state: "idle",
          taskId: null,
          lastHeartbeatAt: new Date(now - 20 * 60_000).toISOString(),
          updatedAt: new Date(now - 20 * 60_000).toISOString(),
        } as unknown as Agent,
      ]);
      const monitor = new HeartbeatMonitor({
        store,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
        pollIntervalMs: 5 * 60_000,
      });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).toContain("Frontend Engineer");
      expect(section).not.toContain("**stale**");
    });

    it("buildReportsHealthSection keeps 60m-interval reports healthy within the grace window", async () => {
      const now = Date.now();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getCachedAgent).mockImplementation((id: string) => ({
        id,
        runtimeConfig: { heartbeatIntervalMs: 60 * 60_000 },
      }) as unknown as Agent);
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        { id: "agent-frontend", name: "Frontend Engineer", state: "active", taskId: "FN-201", lastHeartbeatAt: new Date(now - 53 * 60_000).toISOString(), updatedAt: new Date(now - 53 * 60_000).toISOString() } as Agent,
        { id: "agent-writer", name: "Technical Writer", state: "active", taskId: "FN-202", lastHeartbeatAt: new Date(now - 51 * 60_000).toISOString(), updatedAt: new Date(now - 51 * 60_000).toISOString() } as Agent,
        { id: "agent-qa", name: "QA Engineer", state: "active", taskId: "FN-203", lastHeartbeatAt: new Date(now - 35 * 60_000).toISOString(), updatedAt: new Date(now - 35 * 60_000).toISOString() } as Agent,
        { id: "agent-ci", name: "CI Engineer", state: "active", taskId: "FN-204", lastHeartbeatAt: new Date(now - 39 * 60_000).toISOString(), updatedAt: new Date(now - 39 * 60_000).toISOString() } as Agent,
      ]);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).not.toContain("**stale**");
      expect(section).toContain("Frontend Engineer");
      expect(section).toContain("Technical Writer");
      expect(section).toContain("QA Engineer");
      expect(section).toContain("CI Engineer");
    });

    it("buildReportsHealthSection marks overdue 60m-interval reports as stale", async () => {
      const now = Date.now();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getCachedAgent).mockImplementation((id: string) => ({
        id,
        runtimeConfig: { heartbeatIntervalMs: 60 * 60_000 },
      }) as unknown as Agent);
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        {
          id: "agent-overdue-a",
          name: "Overdue A",
          state: "active",
          taskId: "FN-205",
          lastHeartbeatAt: new Date(now - ((1 * 60 + 47) * 60_000 + 4 * 60 * 60_000)).toISOString(),
          updatedAt: new Date(now - ((1 * 60 + 47) * 60_000 + 4 * 60 * 60_000)).toISOString(),
        } as Agent,
        {
          id: "agent-overdue-b",
          name: "Overdue B",
          state: "active",
          taskId: "FN-206",
          lastHeartbeatAt: new Date(now - 5 * 60 * 60_000).toISOString(),
          updatedAt: new Date(now - 5 * 60 * 60_000).toISOString(),
        } as Agent,
      ]);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).toContain("Overdue A");
      expect(section).toContain("Overdue B");
      expect(section).toContain("**stale**");
    });

    it("classifies the FN-8018 field ages as stale using persisted timestamps", async () => {
      const now = Date.now();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getCachedAgent).mockImplementation((id: string) => ({
        id,
        runtimeConfig: { heartbeatIntervalMs: 60 * 60_000 },
      }) as unknown as Agent);
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        { id: "agent-backend", name: "Backend Engineer", state: "active", taskId: null, lastHeartbeatAt: new Date(now - (6 * 60 + 32) * 60_000).toISOString(), updatedAt: new Date(now - (6 * 60 + 32) * 60_000).toISOString() } as Agent,
        { id: "agent-frontend", name: "Frontend Engineer", state: "active", taskId: null, lastHeartbeatAt: new Date(now - (5 * 60 + 59) * 60_000).toISOString(), updatedAt: new Date(now - (5 * 60 + 59) * 60_000).toISOString() } as Agent,
        { id: "agent-writer", name: "Technical Writer", state: "active", taskId: null, lastHeartbeatAt: new Date(now - (6 * 60 + 34) * 60_000).toISOString(), updatedAt: new Date(now - (6 * 60 + 34) * 60_000).toISOString() } as Agent,
      ]);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).toMatch(/\| Backend Engineer \| active \| — \| .* \| \*\*stale\*\* \|/);
      expect(section).toMatch(/\| Frontend Engineer \| active \| — \| .* \| \*\*stale\*\* \|/);
      expect(section).toMatch(/\| Technical Writer \| active \| — \| .* \| \*\*stale\*\* \|/);
    });

    it("classifies an invalid persisted heartbeat as stale", async () => {
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        { id: "agent-invalid-heartbeat", name: "Invalid Heartbeat", state: "active", taskId: null, lastHeartbeatAt: "not-a-timestamp", updatedAt: new Date().toISOString() } as Agent,
      ]);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).toMatch(/\| Invalid Heartbeat \| active \| — \| unknown \| \*\*stale\*\* \|/);
    });

    it.each([
      {
        name: "60-minute interval stays healthy at 45 minutes",
        heartbeatIntervalMs: 60 * 60_000,
        ageMinutes: 45,
        shouldBeStale: false,
      },
      {
        name: "60-minute interval is stale at 100 minutes",
        heartbeatIntervalMs: 60 * 60_000,
        ageMinutes: 100,
        shouldBeStale: true,
      },
      {
        name: "180-minute interval stays healthy at 240 minutes",
        heartbeatIntervalMs: 180 * 60_000,
        ageMinutes: 240,
        shouldBeStale: false,
      },
      {
        name: "180-minute interval is stale at 280 minutes",
        heartbeatIntervalMs: 180 * 60_000,
        ageMinutes: 280,
        shouldBeStale: true,
      },
    ])("buildReportsHealthSection applies 1.5× heartbeatIntervalMs stale threshold (FN-4295): $name", async ({
      heartbeatIntervalMs,
      ageMinutes,
      shouldBeStale,
    }) => {
      const now = Date.now();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getCachedAgent).mockImplementation((id: string) => ({
        id,
        runtimeConfig: { heartbeatIntervalMs },
      }) as unknown as Agent);
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        {
          id: "agent-threshold-check",
          name: "Threshold Check",
          state: "active",
          taskId: "FN-4295",
          lastHeartbeatAt: new Date(now - ageMinutes * 60_000).toISOString(),
          updatedAt: new Date(now - ageMinutes * 60_000).toISOString(),
        } as Agent,
      ]);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      if (shouldBeStale) {
        expect(section).toContain("**stale**");
      } else {
        expect(section).not.toContain("**stale**");
      }
    });

    it("buildReportsHealthSection applies interval-specific stale thresholds in mixed report tables", async () => {
      const now = Date.now();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getCachedAgent).mockImplementation((id: string) => {
        if (id === "agent-short") {
          return { id, runtimeConfig: { heartbeatIntervalMs: 5 * 60_000 } } as unknown as Agent;
        }
        if (id === "agent-medium") {
          return { id, runtimeConfig: { heartbeatIntervalMs: 60 * 60_000 } } as unknown as Agent;
        }
        if (id === "agent-long") {
          return { id, runtimeConfig: { heartbeatIntervalMs: 4 * 60 * 60_000 } } as unknown as Agent;
        }
        return null;
      });
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        { id: "agent-short", name: "Short Interval", state: "active", taskId: "FN-207", lastHeartbeatAt: new Date(now - 30 * 60_000).toISOString(), updatedAt: new Date(now - 30 * 60_000).toISOString() } as Agent,
        { id: "agent-medium", name: "Medium Interval", state: "active", taskId: "FN-208", lastHeartbeatAt: new Date(now - 30 * 60_000).toISOString(), updatedAt: new Date(now - 30 * 60_000).toISOString() } as Agent,
        { id: "agent-long", name: "Long Interval", state: "active", taskId: "FN-209", lastHeartbeatAt: new Date(now - 30 * 60_000).toISOString(), updatedAt: new Date(now - 30 * 60_000).toISOString() } as Agent,
      ]);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).toMatch(/\| Short Interval \| active \| FN-207 \| .* \| \*\*stale\*\* \|/);
      expect(section).toMatch(/\| Medium Interval \| active \| FN-208 \| .* \| healthy \|/);
      expect(section).toMatch(/\| Long Interval \| active \| FN-209 \| .* \| healthy \|/);
    });

    it("buildReportsHealthSection enforces a 10-minute minimum staleness floor", async () => {
      const now = Date.now();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getCachedAgent).mockImplementation((id: string) => ({
        id,
        runtimeConfig: { heartbeatIntervalMs: 1_000 },
      }) as unknown as Agent);
      // 7 minutes silent with a 1s interval: under the old 5-minute floor this
      // would read as stale, but the 10-minute floor must still treat a busy
      // long-running agent as healthy (e.g. mid multi-minute test command).
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        { id: "agent-fast", name: "Fast Poller", state: "active", taskId: "FN-210", lastHeartbeatAt: new Date(now - 7 * 60_000).toISOString(), updatedAt: new Date(now - 7 * 60_000).toISOString() } as Agent,
      ]);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).toContain("Fast Poller");
      expect(section).not.toContain("**stale**");
    });

    it("buildReportsHealthSection logs stale decisions with interval source (FN-5362)", async () => {
      const now = Date.now();
      const store = createStoreWithAgentForExec();
      vi.mocked(store.getCachedAgent).mockReturnValue(null);
      vi.mocked(store.getAgent).mockResolvedValue({
        id: "agent-overdue",
        runtimeConfig: { heartbeatIntervalMs: 60 * 60_000 },
      } as unknown as Agent);
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        {
          id: "agent-overdue",
          name: "Overdue",
          state: "active",
          taskId: null,
          lastHeartbeatAt: new Date(now - 100 * 60_000).toISOString(),
          updatedAt: new Date(now - 100 * 60_000).toISOString(),
        } as unknown as Agent,
      ]);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp", pollIntervalMs: 5 * 60_000 });

      await (monitor as any).buildReportsHealthSection("agent-001", store);

      expect(heartbeatLog.log).toHaveBeenCalledWith(
        expect.stringContaining("[reports-health] stale report agent-overdue intervalSource=runtimeConfig"),
      );
      expect(heartbeatLog.log).toHaveBeenCalledWith(expect.stringContaining("staleThresholdMs="));
      expect(heartbeatLog.log).toHaveBeenCalledWith(expect.stringContaining("heartbeatAgeMs="));
    });

    it("buildReportsHealthSection preserves AgentStore method binding for direct-report lookups", async () => {
      const now = new Date().toISOString();
      const report = { id: "agent-004", name: "bound-report", state: "active", taskId: "FN-102", reportsTo: "agent-001", lastHeartbeatAt: now, updatedAt: now } as Agent;
      const store = createStoreWithAgentForExec() as AgentStore & {
        listAgents: ReturnType<typeof vi.fn>;
        getAgentsByReportsTo: (agentId: string) => Promise<Agent[]>;
      };
      store.listAgents = vi.fn().mockResolvedValue([mockAgent, report]);
      store.getAgentsByReportsTo = async function (agentId: string) {
        const agents = await this.listAgents();
        return agents.filter((candidate: Agent) => candidate.reportsTo === agentId);
      };
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const section = await (monitor as any).buildReportsHealthSection("agent-001", store);
      expect(section).toContain("bound-report");
      expect(store.listAgents).toHaveBeenCalledTimes(1);
    });

    it("executeHeartbeat includes reports health section when agent has reports", async () => {
      const store = createStoreWithAgentForExec({ taskId: "FN-001" });
      const now = new Date().toISOString();
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([
        { id: "agent-010", name: "reporter", state: "running", taskId: "FN-200", lastHeartbeatAt: now, updatedAt: now } as Agent,
      ]);
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });
      const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(executionPrompt).toContain("## Reports Health Check");
      expect(executionPrompt).toContain("reporter");
    });

    it("executeHeartbeat omits reports health section when agent has no reports", async () => {
      const store = createStoreWithAgentForExec({ taskId: "FN-001" });
      vi.mocked(store.getAgentsByReportsTo).mockResolvedValue([]);
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });
      const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(executionPrompt).not.toContain("## Reports Health Check");
    });
  });

  it("passes action gate and permanent gating context for permanent heartbeat agents", async () => {
    const store = createStoreWithAgentForExec({ taskId: "FN-001" });
    const mockSession = createMockAgentSession();
    mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

    const args = mockedCreateFnAgent.mock.calls[0]?.[0] as {
      actionGateContext?: { agentId: string; isEphemeral: boolean };
      permanentAgentGating?: { permissionPolicy?: { presetId: string } };
    };
    expect(args.actionGateContext?.agentId).toBe("agent-001");
    expect(args.actionGateContext?.isEphemeral).toBe(false);
    expect(args.permanentAgentGating?.permissionPolicy?.presetId).toBe("unrestricted");
  });

  describe("agent pause does not pause assigned tasks", () => {
    it("ignores both cascade values and leaves every assigned-task pause state untouched", async () => {
      for (const cascadeToTasks of [false, true]) {
        const assignedTasks = [
          { id: "FN-USER", paused: true, userPaused: true, pausedByAgentId: undefined, pausedReason: "manual" },
          { id: "FN-OWN", paused: true, userPaused: false, pausedByAgentId: "agent-001", pausedReason: "legacy-agent-pause" },
          { id: "FN-OTHER", paused: true, userPaused: false, pausedByAgentId: "agent-other", pausedReason: "other-agent-pause" },
          { id: "FN-LIVE", paused: false, userPaused: false, pausedByAgentId: undefined, pausedReason: undefined },
        ];
        const pauseTask = vi.fn().mockResolvedValue(undefined);
        const getTasksByAssignedAgent = vi.fn().mockResolvedValue(assignedTasks);
        mockTaskStore = createMockTaskStore({ pauseTask, getTasksByAssignedAgent });
        const store = createStoreWithAgentForExec({ taskId: "FN-USER" });
        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const before = structuredClone(assignedTasks);

        await monitor.pauseAgent("agent-001", { cascadeToTasks });

        expect(pauseTask).not.toHaveBeenCalled();
        expect(getTasksByAssignedAgent).not.toHaveBeenCalled();
        expect(assignedTasks).toEqual(before);
      }
    });

    it("reproduces agent sleep symptom and keeps assigned task pause fields unchanged", async () => {
      const assignedTask = {
        id: "FN-001",
        column: "todo",
        paused: undefined,
        pausedByAgentId: undefined,
      };
      const pauseTask = vi.fn().mockResolvedValue(undefined);
      mockTaskStore = createMockTaskStore({
        pauseTask,
        getTasksByAssignedAgent: vi.fn().mockResolvedValue([assignedTask]),
      });
      const store = createStoreWithAgentForExec({ taskId: "FN-001" });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.pauseAgent("agent-001");

      expect(pauseTask).not.toHaveBeenCalled();
      expect(assignedTask.paused).toBeUndefined();
      expect(assignedTask.pausedByAgentId).toBeUndefined();
      expect(assignedTask.column).toBe("todo");
    });

    it("executeHeartbeat does not pause its assigned task", async () => {
      const pauseTask = vi.fn().mockResolvedValue(undefined);
      mockTaskStore = createMockTaskStore({ pauseTask });
      const store = createStoreWithAgentForExec({ taskId: "FN-001" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(pauseTask).not.toHaveBeenCalledWith(expect.any(String), true, expect.anything(), expect.anything());
      expect(pauseTask).not.toHaveBeenCalled();
    });

    it("captures the task baseline before heartbeat prompting so only prompted tokens persist", async () => {
      const task = {
        id: "FN-001",
        title: "Token task",
        description: "Account heartbeat tokens",
        prompt: "# PROMPT.md",
        steps: [],
        column: "todo",
        worktree: "/tmp/worktree-fn-001",
        branch: "fusion/fn-001",
        dependencies: [],
        log: [],
        attachments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as TaskDetail;
      const updateTask = vi.fn(async (_taskId: string, patch: Partial<TaskDetail>) => Object.assign(task, patch));
      mockTaskStore = createMockTaskStore({
        getTask: vi.fn(async () => task),
        updateTask,
      });
      const store = createStoreWithAgentForExec({ taskId: "FN-001" });
      const stats = { input: 1_000, output: 400, cacheRead: 50, cacheWrite: 10 };
      const mockSession = createMockAgentSession() as any;
      mockSession.getSessionStats = vi.fn(() => ({ tokens: stats }));
      mockSession.prompt.mockImplementation(async () => {
        Object.assign(stats, { input: 1_020, output: 410, cacheRead: 54, cacheWrite: 12 });
      });
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect((task as any).tokenUsage).toMatchObject({
        inputTokens: 20,
        outputTokens: 10,
        cachedTokens: 4,
        cacheWriteTokens: 2,
        totalTokens: 36,
      });
    });

    it("resumeAgent defaults to non-cascading and legacy cascade skips user/other-agent pauses", async () => {
      const pauseTask = vi.fn().mockResolvedValue(undefined);
      const getTasksByAssignedAgent = vi.fn().mockResolvedValue([
        { id: "FN-001", paused: true, pausedByAgentId: "agent-001", userPaused: false, pausedReason: "legacy-agent-pause" },
        { id: "FN-002", paused: true, pausedByAgentId: "agent-001", userPaused: true, pausedReason: "manual" },
        { id: "FN-003", paused: true, pausedByAgentId: "agent-other", userPaused: false, pausedReason: "other-agent-pause" },
      ]);
      mockTaskStore = createMockTaskStore({ pauseTask, getTasksByAssignedAgent });
      const store = createStoreWithAgentForExec({
        taskId: "FN-001",
        state: "active",
        runtimeConfig: { enabled: false },
      });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.resumeAgent("agent-001");
      expect(getTasksByAssignedAgent).not.toHaveBeenCalled();
      expect(pauseTask).not.toHaveBeenCalled();

      await monitor.resumeAgent("agent-001", { cascadeToTasks: true });

      expect(getTasksByAssignedAgent).toHaveBeenCalledWith("agent-001", {
        pausedOnly: true,
        excludeArchived: true,
      });
      expect(pauseTask).toHaveBeenCalledTimes(1);
      expect(pauseTask).toHaveBeenCalledWith("FN-001", false);
      expect(pauseTask).not.toHaveBeenCalledWith("FN-002", false);
      expect(pauseTask).not.toHaveBeenCalledWith("FN-003", false);
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    });
  });

  it("pauseForApproval pauses task and agent when taskId exists", async () => {
    const store = createStoreWithAgentForExec({ taskId: "FN-001" });
    const pauseTask = vi.fn().mockResolvedValue(undefined);
    const logEntry = vi.fn().mockResolvedValue(undefined);
    mockTaskStore = createMockTaskStore({ pauseTask, logEntry });
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const ctx = (monitor as any).buildActionGateContext({ id: "agent-001", name: "Test Agent", permissionPolicy: undefined }, "FN-001", "run-1");
    await ctx.pauseForApproval({
      approvalRequestId: "apr-1",
      decision: {
        disposition: "require-approval",
        category: "command_execution",
        toolName: "bash",
        operation: "git commit",
        summary: "bash: git commit",
        resourceType: "git",
        approvalDedupeKey: "dedupe-1",
        metadata: {},
      },
    });

    // FN-7736: heartbeat pauseForApproval must mirror executor.ts and stamp
    // the canonical AWAITING_APPROVAL_PAUSE_REASON on the task, not just the
    // agent's pauseReason.
    expect(pauseTask).toHaveBeenCalledWith("FN-001", true, undefined, { pausedByAgentId: "agent-001", pausedReason: "awaiting-approval" });
    expect((store.updateAgentState as any)).toHaveBeenCalledWith("agent-001", "paused");
    expect((store.updateAgent as any)).toHaveBeenCalledWith("agent-001", { pauseReason: "awaiting-approval" });
  });

  it("pauseForApproval still pauses agent when taskId is undefined", async () => {
    const store = createStoreWithAgentForExec({ taskId: undefined });
    const pauseTask = vi.fn().mockResolvedValue(undefined);
    mockTaskStore = createMockTaskStore({ pauseTask });
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const ctx = (monitor as any).buildActionGateContext({ id: "agent-001", name: "Test Agent", permissionPolicy: undefined }, undefined, "run-1");
    await ctx.pauseForApproval({
      approvalRequestId: "apr-1",
      decision: {
        disposition: "require-approval",
        category: "command_execution",
        toolName: "bash",
        operation: "git commit",
        summary: "bash: git commit",
        resourceType: "git",
        approvalDedupeKey: "dedupe-1",
        metadata: {},
      },
    });

    expect(pauseTask).not.toHaveBeenCalled();
    expect((store.updateAgentState as any)).toHaveBeenCalledWith("agent-001", "paused");
    expect((store.updateAgent as any)).toHaveBeenCalledWith("agent-001", { pauseReason: "awaiting-approval" });
  });

  it("passes permission gating context for ephemeral heartbeat agents", async () => {
    const store = createStoreWithAgentForExec({
      taskId: "FN-001",
      metadata: { agentKind: "task-worker" },
      name: "executor-ephemeral",
      reportsTo: undefined,
    });
    const mockSession = createMockAgentSession();
    mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

    const args = mockedCreateFnAgent.mock.calls[0]?.[0] as {
      permanentAgentGating?: unknown;
      actionGateContext?: unknown;
    };
    expect(args.permanentAgentGating).toMatchObject({
      permissionPolicy: { presetId: "unrestricted" },
      requester: { actorId: "agent-001", actorName: "executor-ephemeral" },
    });
    expect(args.actionGateContext).toMatchObject({
      agentId: "agent-001",
      agentName: "executor-ephemeral",
      isEphemeral: true,
      permissionPolicy: { presetId: "unrestricted" },
    });
  });

  describe("dependency validation", () => {
    it("throws when taskStore is not configured", async () => {
      const store = createStoreWithAgentForExec();
      const monitor = new HeartbeatMonitor({ store, rootDir: "/tmp" });

      await expect(
        monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" })
      ).rejects.toThrow("HeartbeatMonitor not configured for execution (missing taskStore/rootDir)");
    });

    it("throws when rootDir is not configured", async () => {
      const store = createStoreWithAgentForExec();
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore });

      await expect(
        monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" })
      ).rejects.toThrow("HeartbeatMonitor not configured for execution (missing taskStore/rootDir)");
    });
  });

  describe("graceful exit", () => {
    it("completes with no_assignment when agent has no taskId and no explicit taskId", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result).toBeDefined();
      expect(result.status).toBe("completed");
      expect(result.resultJson).toEqual({ reason: "no_assignment" });
      // Should NOT have created an agent session
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    });

    it("completes with invalid_state when agent state is paused", async () => {
      const store = createStoreWithAgentForExec({ state: "paused" });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result).toBeDefined();
      expect(result.status).toBe("completed");
      expect(result.resultJson).toEqual({ reason: "invalid_state", state: "paused" });
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
      expect(store.updateAgentState).not.toHaveBeenCalledWith("agent-001", "active");
    });

    it("completes with invalid_state when agent state is error", async () => {
      const store = createStoreWithAgentForExec({ state: "error" });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result).toBeDefined();
      expect(result.status).toBe("completed");
      // FNXC:HeartbeatTests 2026-07-12-16:10: FN-7878 makes absent/generic durable-agent lastError recoverable, but this executor-harness agent is not recovery-eligible; it should remain a normal invalid-state exit instead of fabricating an unrecoverable park.
      expect(result.resultJson).toEqual({ reason: "invalid_state", state: "error" });
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
    });

    it("keeps terminated as a run status while pausing the agent", async () => {
      const store = createStoreWithAgentForExec({ state: "running" });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const run = await monitor.startRun("agent-001", { source: "on_demand" });

      await monitor.completeRun("agent-001", run.id, {
        status: "terminated",
        stderrExcerpt: "Run stopped by user",
      });

      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "running");
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "paused");
      expect(store.endHeartbeatRun).toHaveBeenCalledWith(run.id, "terminated");
    });

    it("clears stale lastError after a subsequent successful heartbeat run", async () => {
      const store = createStoreWithAgentForExec({ state: "running" });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const failedRun = await monitor.startRun("agent-001", { source: "on_demand" });
      await monitor.completeRun("agent-001", failedRun.id, {
        status: "failed",
        stderrExcerpt: "Prompt failed",
      });

      const successfulRun = await monitor.startRun("agent-001", { source: "on_demand" });
      await monitor.completeRun("agent-001", successfulRun.id, {
        status: "completed",
      });

      // FNXC:HeartbeatTests 2026-07-12-16:10: FN-7878 changed generic heartbeat failures such as "Prompt failed" from immediate `error-unrecoverable` parking to bare `error` so the bounded retry budget can run. The subsequent successful run still clears the stale lastError and returns to active.
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "error");
      expect(store.updateAgentState).not.toHaveBeenCalledWith("agent-001", "paused");
      expect(store.updateAgent).toHaveBeenCalledWith("agent-001", expect.objectContaining({ lastError: "Prompt failed" }));
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
      // FNXC:HeartbeatTests 2026-07-12-10:10: FN-7835's success path also resets error-recovery metadata alongside lastError, so use objectContaining to tolerate the extra metadata key.
      expect(store.updateAgent).toHaveBeenCalledWith("agent-001", expect.objectContaining({ lastError: undefined }));
    });

    it("completes as failed when agent not found in store", async () => {
      const store = createStoreWithAgentForExec();
      (store.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result).toBeDefined();
      expect(result.status).toBe("failed");
      expect(result.stderrExcerpt).toContain("not found");
    });

    it("completes with task_not_found when task does not exist", async () => {
      const store = createStoreWithAgentForExec({ taskId: "FN-MISSING" });
      mockTaskStore.getTask = vi.fn().mockRejectedValue(new Error("Task FN-MISSING not found"));
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result).toBeDefined();
      expect(result.status).toBe("completed");
      expect(result.resultJson).toEqual({ reason: "task_not_found", taskId: "FN-MISSING" });
    });

    it("clears archived task assignments and falls back to a no-task heartbeat for identity agents", async () => {
      const appendAgentLog = vi.fn().mockResolvedValue(undefined);
      mockTaskStore = createMockTaskStore({
        appendAgentLog,
        getTask: vi.fn().mockResolvedValue({
          id: "FN-ARCHIVED",
          title: "Archived Task",
          description: "Archived task description",
          prompt: "# Archived\n\nTask is archived",
          steps: [],
          column: "archived",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail),
      });
      const store = createStoreWithAgentForExec({
        taskId: "FN-ARCHIVED",
        soul: "Monitor the project and handle ambient work.",
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect((store.assignTask as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "agent-001",
        undefined,
        expect.objectContaining({ agentId: "agent-001", source: "on_demand" }),
      );
      expect(result.status).toBe("completed");
      expect(result.resultJson).toEqual(expect.objectContaining({ reason: "no_assignment_identity_run" }));
      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      const toolNames = mockedCreateFnAgent.mock.calls[0]![0]!.customTools!.map((tool: any) => tool.name);
      expect(toolNames).not.toContain("fn_task_log");
      expect(toolNames).not.toContain("fn_task_document_write");
      expect(toolNames).not.toContain("fn_task_document_read");
      expect(appendAgentLog).not.toHaveBeenCalled();
    });

    it("exits gracefully for explicit terminal task overrides that are not the agent's current assignment", async () => {
      mockTaskStore = createMockTaskStore({
        getTask: vi.fn().mockResolvedValue({
          id: "FN-DONE",
          title: "Done Task",
          description: "Done task description",
          prompt: "# Done\n\nTask is done",
          steps: [],
          column: "done",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail),
      });
      const store = createStoreWithAgentForExec({
        taskId: "FN-LIVE",
        soul: "Stay helpful.",
      });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "on_demand",
        taskId: "FN-DONE",
      });

      expect(result.status).toBe("completed");
      expect(result.resultJson).toEqual({ reason: "terminal_task", taskId: "FN-DONE", column: "done" });
      expect(store.assignTask).not.toHaveBeenCalledWith("agent-001", undefined, expect.anything());
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    });
  });

  // ── Identity Agents Without Tasks ─────────────────────────────────────────────
  // FN-2051: Agents with identity (soul, instructions, memory) should run heartbeat
  // sessions even without a task assignment, enabling them to do ambient work like
  // messaging, memory management, task creation, and delegation.
  describe("identity agents without tasks", () => {
    function makeAutoClaimTask(overrides: Partial<TaskDetail> & Pick<TaskDetail, "id">): TaskDetail {
      return {
        id: overrides.id,
        description: overrides.description ?? "executor reliability follow-up",
        title: overrides.title ?? "Executor reliability",
        prompt: overrides.prompt ?? "",
        steps: overrides.steps ?? [],
        column: overrides.column ?? "todo",
        dependencies: overrides.dependencies ?? [],
        log: overrides.log ?? [],
        attachments: overrides.attachments ?? [],
        createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
        updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
        paused: overrides.paused,
        assignedAgentId: overrides.assignedAgentId,
        checkedOutBy: overrides.checkedOutBy,
        deletedAt: overrides.deletedAt,
      } as unknown as TaskDetail;
    }

    it("agent WITH soul but no task creates session and completes successfully", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator agent who monitors project health" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result).toBeDefined();
      expect(result.status).toBe("completed");
      // Should create a session
      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      // Reason should indicate identity run
      expect(result.resultJson).toEqual(expect.objectContaining({ reason: "no_assignment_identity_run" }));
    });

    it("auto-claim disabled skips candidate claiming during no-task runs", async () => {
      const store = createStoreWithAgentForExec({
        taskId: undefined,
        soul: "I am a coordinator",
        runtimeConfig: { autoClaimRelevantTasks: false },
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      mockTaskStore = createMockTaskStore({
        listTasks: vi.fn().mockResolvedValue([
          {
            id: "FN-CANDIDATE",
            description: "executor workflow cleanup",
            title: "Executor cleanup",
            prompt: "",
            steps: [],
            column: "todo",
            dependencies: [],
            log: [],
            attachments: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as unknown as TaskDetail,
        ]),
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect((store.claimTaskForAgent as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(executionPrompt).toContain("auto-claim relevant tasks: disabled");
    });

    it("auto-claim enabled attempts to claim relevant no-task candidates", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, soul: "executor reliability owner" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      mockTaskStore = createMockTaskStore({
        listTasks: vi.fn().mockResolvedValue([
          {
            id: "FN-CANDIDATE",
            description: "executor reliability follow-up",
            title: "Executor reliability",
            prompt: "",
            steps: [],
            column: "todo",
            dependencies: [],
            log: [],
            attachments: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as unknown as TaskDetail,
        ]),
        getTask: vi.fn().mockImplementation(async (id: string) => ({
          id,
          title: "Executor reliability",
          description: "executor reliability follow-up",
          prompt: "# PROMPT",
          steps: [],
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail)),
      });

      (store.claimTaskForAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        task: { id: "FN-CANDIDATE" },
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(store.claimTaskForAgent).toHaveBeenCalledWith(
        "agent-001",
        "FN-CANDIDATE",
        expect.objectContaining({ agentId: "agent-001", source: "timer" }),
      );
      const toolNames = mockedCreateFnAgent.mock.calls[0]![0]!.customTools!.map((tool: any) => tool.name);
      expect(toolNames).toContain("fn_task_log");
    });

    it("honors engineerBacklogAutoClaim precedence for no-task auto-claim role compatibility", async () => {
      const oldEnoughForBaseScore = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const candidateTask = {
        id: "FN-CANDIDATE",
        description: "implementation reliability follow-up",
        title: "Implementation reliability",
        prompt: "# PROMPT",
        steps: [],
        column: "todo",
        dependencies: [],
        log: [],
        attachments: [],
        createdAt: oldEnoughForBaseScore,
        updatedAt: oldEnoughForBaseScore,
        columnMovedAt: oldEnoughForBaseScore,
      } as unknown as TaskDetail;
      const scenarios = [
        { name: "engineer default", role: "engineer", settings: {}, runtimeConfig: {}, shouldClaim: false, promptText: "compatible backlog blocked; engineerBacklogAutoClaim disabled", assertEngineerGuidance: true },
        { name: "engineer project opt-in", role: "engineer", settings: { engineerBacklogAutoClaim: true }, runtimeConfig: {}, shouldClaim: true },
        { name: "engineer runtime opt-in overrides project off", role: "engineer", settings: { engineerBacklogAutoClaim: false }, runtimeConfig: { engineerBacklogAutoClaim: true }, shouldClaim: true },
        { name: "engineer runtime opt-out overrides project on", role: "engineer", settings: { engineerBacklogAutoClaim: true }, runtimeConfig: { engineerBacklogAutoClaim: false }, shouldClaim: false, promptText: "compatible backlog blocked; engineerBacklogAutoClaim disabled", assertEngineerGuidance: true },
        { name: "executor unchanged", role: "executor", settings: { engineerBacklogAutoClaim: false }, runtimeConfig: {}, shouldClaim: true },
        { name: "reviewer blocked with opt-in", role: "reviewer", settings: { engineerBacklogAutoClaim: true }, runtimeConfig: {}, shouldClaim: false, promptText: "executor or opted-in engineer role required" },
        { name: "custom blocked with opt-in", role: "custom", settings: { engineerBacklogAutoClaim: true }, runtimeConfig: {}, shouldClaim: false, promptText: "executor or opted-in engineer role required" },
      ] as const;

      for (const scenario of scenarios) {
        vi.clearAllMocks();
        mockedAcquireTaskWorktree.mockResolvedValue({
          worktreePath: "/tmp/worktree-fn-candidate",
          branch: "fusion/fn-candidate",
          source: "existing",
          hydrated: false,
          isResume: true,
        });
        const store = createStoreWithAgentForExec({
          taskId: undefined,
          role: scenario.role,
          soul: "implementation reliability owner",
          runtimeConfig: scenario.runtimeConfig,
        });
        const mockSession = createMockAgentSession();
        mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
        mockTaskStore = createMockTaskStore({
          getSettings: vi.fn().mockResolvedValue(scenario.settings),
          listTasks: vi.fn().mockResolvedValue([candidateTask]),
          getTask: vi.fn().mockResolvedValue(candidateTask),
        });
        (store.claimTaskForAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          task: { id: "FN-CANDIDATE" },
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        if (scenario.shouldClaim) {
          expect(store.claimTaskForAgent, scenario.name).toHaveBeenCalledWith(
            "agent-001",
            "FN-CANDIDATE",
            expect.objectContaining({ agentId: "agent-001", source: "timer" }),
          );
        } else {
          expect(store.claimTaskForAgent, scenario.name).not.toHaveBeenCalled();
          const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
          expect(executionPrompt, scenario.name).toContain(scenario.promptText);
          if ("assertEngineerGuidance" in scenario && scenario.assertEngineerGuidance) {
            expect(executionPrompt, scenario.name).toContain("Snapshot found 1 eligible Todo task(s), but this engineer-role agent is not opted into backlog auto-claim.");
            expect(executionPrompt, scenario.name).toContain("Settings → Scheduling & Capacity → \"Let engineer agents auto-claim backlog tasks\" (settings.engineerBacklogAutoClaim)");
            expect(executionPrompt, scenario.name).toContain("Agents → Agent Detail → Settings → Heartbeat Settings → \"Engineer Backlog Auto-Claim\" (runtimeConfig.engineerBacklogAutoClaim)");
            expect(executionPrompt, scenario.name).toContain("Next action: delegate one of the listed tasks to an executor/opted-in engineer or create a coordination follow-up");
            expect(executionPrompt, scenario.name).toContain("- FN-CANDIDATE: Implementation reliability");
          }
        }
      }
    });

    it("auto-claim skips implementation candidates for non-executor agents", async () => {
      const store = createStoreWithAgentForExec({
        taskId: undefined,
        role: "reviewer",
        soul: "review workflows",
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      mockTaskStore = createMockTaskStore({
        listTasks: vi.fn().mockResolvedValue([
          {
            id: "FN-CANDIDATE",
            description: "executor reliability follow-up",
            title: "Executor reliability",
            prompt: "",
            steps: [],
            column: "todo",
            dependencies: [],
            log: [],
            attachments: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as unknown as TaskDetail,
        ]),
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(store.claimTaskForAgent).not.toHaveBeenCalled();
    });

    it("explains empty auto-claim prompt candidates when role policy filters eligible todo tasks", async () => {
      const store = createStoreWithAgentForExec({
        taskId: undefined,
        role: "reviewer",
        soul: "review workflows",
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      mockTaskStore = createMockTaskStore({
        listTasks: vi.fn().mockResolvedValue([
          {
            id: "FN-CANDIDATE",
            description: "executor reliability follow-up",
            title: "Executor reliability",
            prompt: "",
            steps: [],
            column: "todo",
            dependencies: [],
            log: [],
            attachments: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as unknown as TaskDetail,
        ]),
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(executionPrompt).toContain("auto-claim relevant tasks: enabled (no role-compatible candidates; executor role required)");
      expect(executionPrompt).toContain("Open Task Candidates (auto-claim scan):");
      expect(executionPrompt).toContain("Snapshot found 1 eligible Todo task(s), but this agent role cannot auto-claim implementation work.");
    });

    it.each([
      { name: "executor display", role: "executor" as const, soul: "ambient gardener", runtimeConfig: undefined, expectedStatus: "auto-claim relevant tasks: enabled" },
      { name: "engineer role fallback", role: "engineer" as const, soul: "ambient gardener", runtimeConfig: { engineerBacklogAutoClaim: false }, expectedStatus: "auto-claim relevant tasks: enabled (compatible backlog blocked; engineerBacklogAutoClaim disabled)" },
    ])("re-resolves stale cached candidates for $name", async (scenario) => {
      const promptOnlyCreatedAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const staleCachedTask = makeAutoClaimTask({
        id: "FN-6812",
        title: "Executor stale cached title",
        description: "executor matching stale task",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const renamedCachedTask = makeAutoClaimTask({
        id: "FN-RENAMED",
        title: "Old queued title",
        description: "old queued description",
        createdAt: promptOnlyCreatedAt,
      });
      const staleCanonicalTask = makeAutoClaimTask({
        id: "FN-6812",
        title: "Superseded pending Shadcn-family sidebar accent gap check",
        description: "superseded and back in planning",
        column: "triage",
        dependencies: ["FN-6830"],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const renamedCanonicalTask = makeAutoClaimTask({
        id: "FN-RENAMED",
        title: "Updated canonical backlog title",
        description: "updated queued description",
        createdAt: promptOnlyCreatedAt,
      });
      const listTasks = vi.fn()
        .mockResolvedValueOnce([staleCachedTask, renamedCachedTask])
        .mockResolvedValue([staleCanonicalTask, renamedCanonicalTask]);
      const store = createStoreWithAgentForExec({
        taskId: undefined,
        role: scenario.role,
        soul: scenario.soul,
        runtimeConfig: scenario.runtimeConfig,
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      mockTaskStore = createMockTaskStore({
        listTasks,
        getTask: vi.fn().mockResolvedValue(renamedCanonicalTask),
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(store.claimTaskForAgent).not.toHaveBeenCalledWith("agent-001", "FN-6812", expect.anything());
      expect(store.claimTaskForAgent).not.toHaveBeenCalled();
      const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(executionPrompt).toContain(scenario.expectedStatus);
      expect(executionPrompt).toContain("Open Task Candidates (auto-claim scan):");
      expect(executionPrompt).not.toContain("FN-6812");
      expect(executionPrompt).not.toContain("Executor stale cached title");
      expect(executionPrompt).not.toContain("Superseded pending Shadcn-family sidebar accent gap check");
      expect(executionPrompt).not.toContain("Old queued title");
      expect(executionPrompt).toContain("- FN-RENAMED: Updated canonical backlog title");
    });

    it.each([
      { name: "executor display", role: "executor" as const, soul: "Re-ratchet line-count baseline specialist", runtimeConfig: undefined, expectedStatus: "auto-claim relevant tasks: enabled" },
      { name: "engineer role fallback", role: "engineer" as const, soul: "Re-ratchet line-count baseline specialist", runtimeConfig: { engineerBacklogAutoClaim: false }, expectedStatus: "auto-claim relevant tasks: enabled (compatible backlog blocked; engineerBacklogAutoClaim disabled)" },
    ])("drops archived-while-cached candidates from heartbeat prompt and claim path for $name", async (scenario) => {
      const archivedCachedTask = makeAutoClaimTask({
        id: "FN-6872",
        title: "Re-ratchet line-count baseline archived cached title",
        description: "Re-ratchet line-count baseline work that matched this agent before archive",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const siblingCachedTask = makeAutoClaimTask({
        id: "FN-TODO",
        title: "Old neutral queue title",
        description: "neutral queue work",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      const archivedCanonicalTask = makeAutoClaimTask({
        id: "FN-6872",
        title: "Re-ratchet line-count baseline archived canonical title",
        description: "archived within the snapshot TTL",
        column: "archived",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const siblingCanonicalTask = makeAutoClaimTask({
        id: "FN-TODO",
        title: "Canonical neutral queue title",
        description: "canonical neutral work",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      const listTasks = vi.fn()
        .mockResolvedValueOnce([archivedCachedTask, siblingCachedTask])
        .mockResolvedValue([archivedCanonicalTask, siblingCanonicalTask]);
      const store = createStoreWithAgentForExec({
        taskId: undefined,
        role: scenario.role,
        soul: scenario.soul,
        runtimeConfig: scenario.runtimeConfig,
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      mockTaskStore = createMockTaskStore({
        listTasks,
        getTask: vi.fn().mockResolvedValue(siblingCanonicalTask),
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(store.claimTaskForAgent).not.toHaveBeenCalledWith("agent-001", "FN-6872", expect.anything());
      if (scenario.role === "executor") {
        expect(store.claimTaskForAgent).toHaveBeenCalledWith("agent-001", "FN-TODO", expect.anything());
      } else {
        expect(store.claimTaskForAgent).not.toHaveBeenCalled();
      }
      const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(executionPrompt).toContain(scenario.expectedStatus);
      expect(executionPrompt).toContain("Open Task Candidates (auto-claim scan):");
      expect(executionPrompt).not.toContain("FN-6872");
      expect(executionPrompt).not.toContain("Re-ratchet line-count baseline archived cached title");
      expect(executionPrompt).not.toContain("Re-ratchet line-count baseline archived canonical title");
      expect(executionPrompt).toContain("- FN-TODO: Canonical neutral queue title");
    });

    it("reuses one snapshot rebuild across concurrent no-task heartbeats", async () => {
      const listTasks = vi.fn().mockResolvedValue([
        {
          id: "FN-CANDIDATE",
          description: "executor reliability follow-up",
          title: "Executor reliability",
          prompt: "",
          steps: [],
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail,
      ]);
      mockTaskStore = createMockTaskStore({ listTasks });
      const store = createStoreWithAgentForExec({ taskId: undefined, soul: "executor reliability owner" });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await Promise.all([
        monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" }),
        monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" }),
      ]);

      // FNXC:AutoClaim 2026-06-21-10:35: FN-6850 keeps the snapshot rebuild shared while each no-task heartbeat runs its own canonical freshness gate.
      expect(listTasks).toHaveBeenCalledTimes(3);
    });

    it("omits candidate section when autoClaimCandidatesInPrompt resolves to zero", async () => {
      const store = createStoreWithAgentForExec({
        taskId: undefined,
        soul: "executor reliability owner",
        runtimeConfig: { autoClaimRelevantTasks: true, autoClaimCandidatesInPrompt: 0 },
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(executionPrompt).toContain("auto-claim relevant tasks: disabled (prompt-suppressed)");
      expect(executionPrompt).not.toContain("Open unowned tasks you may auto-claim");
    });

    it("agent WITH instructionsText but no task creates session and completes successfully", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, instructionsText: "Monitor task board and create follow-up tasks" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result).toBeDefined();
      expect(result.status).toBe("completed");
      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      expect(result.resultJson).toEqual(expect.objectContaining({ reason: "no_assignment_identity_run" }));
    });

    it("agent WITH memory but no task creates session and completes successfully", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, memory: "Last week we shipped the new API. Watch for integration issues." });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result).toBeDefined();
      expect(result.status).toBe("completed");
      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      expect(result.resultJson).toEqual(expect.objectContaining({ reason: "no_assignment_identity_run" }));
    });

    it("ephemeral agent with soul but no task still bails with no_assignment", async () => {
      // Ephemeral agents (agentKind: "task-worker") should NOT run no-task sessions
      const store = createStoreWithAgentForExec({
        taskId: undefined,
        soul: "I am a task worker",
        metadata: { agentKind: "task-worker" },
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result).toBeDefined();
      expect(result.status).toBe("completed");
      // Ephemeral agents should NOT create a session
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
      // Should still exit with no_assignment (not no_assignment_identity_run)
      expect(result.resultJson).toEqual({ reason: "no_assignment" });
    });

    it("identity agent without task receives delegation and task assignment tools", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      const callArgs = mockedCreateFnAgent.mock.calls[0]![0]!;
      expect(callArgs.tools).toBe("coding");
      const toolNames = callArgs.customTools!.map((tool: any) => tool.name);

      // Delegation and direct reassignment must remain available together.
      expect(toolNames).toContain("fn_task_create");
      expect(toolNames).toContain("fn_list_agents");
      expect(toolNames).toContain("fn_delegate_task");
      expect(toolNames).toContain("fn_task_assign");
      // Should have fn_heartbeat_done
      expect(toolNames).toContain("fn_heartbeat_done");
      // Should have memory tools
      expect(toolNames).toContain("fn_memory_search");
      expect(toolNames).toContain("fn_memory_append");

      // Should NOT have fn_task_log, fn_task_document_write, fn_task_document_read (they require taskId)
      expect(toolNames).not.toContain("fn_task_log");
      expect(toolNames).not.toContain("fn_task_document_write");
      expect(toolNames).not.toContain("fn_task_document_read");
    });

    it("no-task run receives HEARTBEAT_NO_TASK_SYSTEM_PROMPT as system prompt", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      const callArgs = mockedCreateFnAgent.mock.calls[0]![0]!;
      const systemPrompt = callArgs.systemPrompt;

      expect(systemPrompt).toContain(HEARTBEAT_NO_TASK_SYSTEM_PROMPT);
      expect(systemPrompt).not.toContain("fn_task_log");
      expect(systemPrompt).not.toContain("fn_task_document_write");
      expect(systemPrompt).not.toContain("fn_task_document_read");
      expect(systemPrompt).toContain("fn_task_create");
      expect(systemPrompt).toContain("fn_list_agents");
      expect(systemPrompt).toContain("fn_delegate_task");
      expect(systemPrompt).toContain("fn_read_messages");
      expect(systemPrompt).toContain("fn_send_message");
      expect(systemPrompt).toContain("fn_memory_search");
      expect(systemPrompt).toContain("fn_memory_append");
      expect(systemPrompt).toContain('scope="agent"');
      expect(systemPrompt).toContain('scope="project"');
      expect(systemPrompt).toContain("fn_heartbeat_done");
    });

    it("no-task run gates proactive patrol prompts from workflow setting", async () => {
      for (const [storedValue, shouldPatrol] of [[undefined, true], [true, true], [false, false]] as const) {
        vi.clearAllMocks();
        const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator" });
        const mockSession = createMockAgentSession();
        mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
        const taskStore = createMockTaskStore({
          getSettings: vi.fn().mockResolvedValue({ defaultWorkflowId: "builtin:coding" }),
          getWorkflowSettingsProjectId: vi.fn().mockReturnValue("test-project"),
          getWorkflowSettingValues: vi.fn().mockReturnValue(
            storedValue === undefined ? {} : { plannerHeartbeatPatrolEnabled: storedValue },
          ),
        } as Partial<TaskStore>);

        const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result.status).toBe("completed");
        expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
        const callArgs = mockedCreateFnAgent.mock.calls[0]![0]!;
        const systemPrompt = callArgs.systemPrompt;
        const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0] ?? "";
        const savedRun = await store.getRunDetail("agent-001", result.id);

        if (shouldPatrol) {
          expect(systemPrompt).toContain("Use fn_task_create to spawn follow-up work");
          expect(executionPrompt).toContain("create a focused task instead of attempting unscheduled implementation");
          expect(savedRun?.systemPrompt).toContain("Use fn_task_create to spawn follow-up work");
          expect(savedRun?.executionPrompt).toContain("create a focused task instead of attempting unscheduled implementation");
          expect(systemPrompt).not.toContain(TRIAGE_HEARTBEAT_PATROL_DISABLED_INSTRUCTION);
        } else {
          expect(systemPrompt).toContain(TRIAGE_HEARTBEAT_PATROL_DISABLED_INSTRUCTION);
          expect(executionPrompt).toContain(TRIAGE_HEARTBEAT_PATROL_DISABLED_INSTRUCTION);
          expect(savedRun?.systemPrompt).toContain(TRIAGE_HEARTBEAT_PATROL_DISABLED_INSTRUCTION);
          expect(savedRun?.executionPrompt).toContain(TRIAGE_HEARTBEAT_PATROL_DISABLED_INSTRUCTION);
          expect(systemPrompt).not.toContain("Use fn_task_create to spawn follow-up work");
          expect(executionPrompt).not.toContain("create a focused task instead of attempting unscheduled implementation");
        }
      }
    });

    it("identity agent without task receives no-task execution prompt mentioning 'no assigned task'", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      const callArgs = mockedCreateFnAgent.mock.calls[0]![0]!;
      const systemPrompt = callArgs.systemPrompt;
      expect(systemPrompt).toContain(HEARTBEAT_NO_TASK_SYSTEM_PROMPT);
      expect(systemPrompt).not.toContain("fn_task_log");
      expect(systemPrompt).not.toContain("fn_task_document_write");
      expect(systemPrompt).not.toContain("fn_task_document_read");
      expect(systemPrompt).not.toContain("Task Documents:");
      expect(systemPrompt).toContain("fn_task_create");
      expect(systemPrompt).toContain("fn_heartbeat_done");
      expect(systemPrompt).toContain("fn_memory_append");

      // The execution prompt is passed to session.prompt by promptWithFallback mock
      const promptCalls = mockSession.prompt.mock.calls;
      expect(promptCalls.length).toBeGreaterThan(0);
      const executionPrompt = promptCalls[promptCalls.length - 1]![0]!;

      // Should mention no assigned task
      expect(executionPrompt).toContain("No assigned task");
      // Should describe ambient work capabilities
      expect(executionPrompt).toContain("ambient work");
      expect(executionPrompt).toContain("fn_task_create");
      expect(executionPrompt).toContain("fn_list_agents");
      expect(executionPrompt).toContain("fn_delegate_task");
      // Should NOT include task-specific content
      expect(executionPrompt).not.toContain("Assigned task:");
      expect(executionPrompt).not.toContain("Task description:");
      // Should include Wake Delta + no-task heartbeat procedure (tool-aligned per-tick anchoring)
      expect(executionPrompt).toContain("## Wake Delta");
      expect(executionPrompt).toContain("wake reason:");
      expect(executionPrompt).toContain("autonomous heartbeat run");
      expect(executionPrompt).toContain(HEARTBEAT_NO_TASK_PROCEDURE);
    });

    it("no-task run overrides a seeded task-scoped heartbeatProcedurePath in the assembled prompt", async () => {
      const tmpDir = mkdtempSync(join(process.cwd(), ".tmp-fn-hb-no-task-procedure-"));
      try {
        writeFileSync(join(tmpDir, "HEARTBEAT.md"), HEARTBEAT_PROCEDURE, "utf-8");

        const store = createStoreWithAgentForExec({
          taskId: undefined,
          soul: "I am a coordinator",
          heartbeatProcedurePath: `${tmpDir.split("/").pop()}/HEARTBEAT.md`,
        });
        const mockSession = createMockAgentSession();
        mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: process.cwd() });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result.status).toBe("completed");
        const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0];
        expect(executionPrompt).toBeDefined();
        expect(executionPrompt).not.toContain("fn_task_log");
        expect(executionPrompt).not.toContain("fn_task_document_write");
        expect(executionPrompt).not.toContain("do not re-read PROMPT.md to advance it");
        expect(executionPrompt).toContain("Implementation-scope discovery");

        const savedRun = await store.getRunDetail("agent-001", result.id);
        expect(savedRun?.heartbeatProcedureSource).toBe("default-no-task-override");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("no-task run without a custom heartbeatProcedurePath still uses the ambient procedure", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result.status).toBe("completed");
      const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0];
      expect(executionPrompt).toBeDefined();
      expect(executionPrompt).not.toContain("fn_task_log");
      expect(executionPrompt).not.toContain("fn_task_document_write");
      expect(executionPrompt).not.toContain("do not re-read PROMPT.md to advance it");
      expect(executionPrompt).toContain("Implementation-scope discovery");

      const savedRun = await store.getRunDetail("agent-001", result.id);
      expect(savedRun?.heartbeatProcedureSource).toBe("default");
    });

    it("uses lite task-scoped procedure when project heartbeatScopeDiscipline is lite", async () => {
      const store = createStoreWithAgentForExec({ taskId: "FN-001" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      mockTaskStore = createMockTaskStore({
        getSettings: vi.fn().mockResolvedValue({ heartbeatScopeDiscipline: "lite" }),
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result.status).toBe("completed");
      const persistedRun = vi.mocked(store.saveRun).mock.calls
        .map(([arg]) => arg)
        .find((arg): arg is AgentHeartbeatRun => typeof arg.executionPrompt === "string");
      expect(persistedRun?.executionPrompt).toContain("Assignment review");
      expect(persistedRun?.executionPrompt).toContain("Classify scope before acting");
      expect(persistedRun?.executionPrompt).not.toContain("Per-tick self-check");
      expect(persistedRun?.contextSnapshot?.heartbeatScopeDiscipline).toBe("lite");
    });

    it("uses agent runtimeConfig heartbeatScopeDiscipline over project default", async () => {
      const store = createStoreWithAgentForExec({
        runtimeConfig: { heartbeatScopeDiscipline: "strict" },
        taskId: "FN-001",
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      mockTaskStore = createMockTaskStore({
        getSettings: vi.fn().mockResolvedValue({ heartbeatScopeDiscipline: "lite" }),
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result.status).toBe("completed");
      const persistedRun = vi.mocked(store.saveRun).mock.calls
        .map(([arg]) => arg)
        .find((arg): arg is AgentHeartbeatRun => typeof arg.executionPrompt === "string");
      expect(persistedRun?.executionPrompt).toContain("Per-tick self-check");
      expect(persistedRun?.executionPrompt).toContain("Classify the bound task");
      expect(persistedRun?.executionPrompt).not.toContain("Assignment review");
      expect(persistedRun?.contextSnapshot?.heartbeatScopeDiscipline).toBe("strict");
    });

    it("off mode omits scope-classification guidance", async () => {
      const store = createStoreWithAgentForExec({ taskId: "FN-001" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      mockTaskStore = createMockTaskStore({
        getSettings: vi.fn().mockResolvedValue({ heartbeatScopeDiscipline: "off" }),
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result.status).toBe("completed");
      const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(executionPrompt).toContain(HEARTBEAT_PROCEDURE_OFF);
      expect(executionPrompt).not.toContain("Classify scope before acting");
      expect(executionPrompt).not.toContain("Classify the bound task");

      const savedRun = await store.getRunDetail("agent-001", result.id);
      expect(savedRun?.contextSnapshot?.heartbeatScopeDiscipline).toBe("off");
    });

    it("task-scoped run receives HEARTBEAT_SYSTEM_PROMPT as system prompt", async () => {
      const store = createStoreWithAgentForExec({ taskId: "FN-001" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      const callArgs = mockedCreateFnAgent.mock.calls[0]![0]!;
      const systemPrompt = callArgs.systemPrompt;

      expect(systemPrompt).toContain(HEARTBEAT_SYSTEM_PROMPT);
      expect(systemPrompt).toContain("fn_task_log");
      expect(systemPrompt).toContain("fn_task_document_write");
      expect(systemPrompt).toContain("Task Documents:");
    });

    it("timer task-scoped execution prompt is framed as autonomous heartbeat work", async () => {
      const store = createStoreWithAgentForExec({ taskId: "FN-001" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      const promptCalls = mockSession.prompt.mock.calls;
      expect(promptCalls.length).toBeGreaterThan(0);
      const executionPrompt = promptCalls[promptCalls.length - 1]![0]!;
      expect(executionPrompt).toContain("## Wake Delta");
      expect(executionPrompt).toContain("wake reason: timer");
      expect(executionPrompt).toContain("autonomous heartbeat run");
    });

    it("Wake Delta includes multi-assign coordination inventory for sibling assignments", async () => {
      const now = new Date().toISOString();
      const getTasksByAssignedAgent = vi.fn().mockResolvedValue([
        {
          id: "FN-001",
          column: "in-progress",
          title: "Bound task",
          dependencies: [],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "FN-220",
          column: "todo",
          title: "Sibling todo",
          dependencies: [],
          createdAt: now,
          updatedAt: now,
        },
      ]);
      mockTaskStore = createMockTaskStore({ getTasksByAssignedAgent });
      const store = createStoreWithAgentForExec({ taskId: "FN-001" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(executionPrompt).toContain("- assigned task: FN-001");
      expect(executionPrompt).toContain("coordination inventory");
      expect(executionPrompt).toContain("FN-001");
      expect(executionPrompt).toContain("FN-220");
      expect(executionPrompt).toContain("(bound)");
      expect(getTasksByAssignedAgent).toHaveBeenCalledWith("agent-001", { excludeArchived: true });
    });

    it("exits checkout_conflict without starting a session when lease is held by another agent", async () => {
      const now = new Date().toISOString();
      mockTaskStore = createMockTaskStore({
        getTask: vi.fn().mockResolvedValue({
          id: "FN-001",
          title: "Leased elsewhere",
          description: "desc",
          prompt: "",
          steps: [],
          column: "todo",
          checkedOutBy: "agent-other",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: now,
          updatedAt: now,
        } as unknown as TaskDetail),
      });
      const store = createStoreWithAgentForExec({ taskId: "FN-001" });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result.status).toBe("completed");
      expect(result.resultJson).toEqual({
        reason: "checkout_conflict",
        taskId: "FN-001",
        checkedOutBy: "agent-other",
      });
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    });

    it("identity agent without task gets soul in system prompt", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a CEO who prioritizes high-impact work" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      const callArgs = mockedCreateFnAgent.mock.calls[0]![0]!;
      // Soul should be in the system prompt
      expect(callArgs.systemPrompt).toContain("## Soul");
      expect(callArgs.systemPrompt).toContain("I am a CEO who prioritizes high-impact work");
    });

    it("builds heartbeat system prompt with inline + file instructions plus soul and memory", async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "fn-hb-instr-"));
      try {
        writeFileSync(join(tmpRoot, "instructions.md"), "File-backed operating instruction", "utf-8");
        const store = createStoreWithAgentForExec({
          taskId: undefined,
          instructionsText: "Inline operating instruction",
          instructionsPath: "instructions.md",
          soul: "I am an autonomous agent",
          memory: "Remember to prefer concrete actions",
        });
        const mockSession = createMockAgentSession();
        mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: tmpRoot });
        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        const callArgs = mockedCreateFnAgent.mock.calls[0]![0]!;
        expect(callArgs.systemPrompt).toContain("Inline operating instruction");
        expect(callArgs.systemPrompt).toContain("File-backed operating instruction");
        expect(callArgs.systemPrompt).toContain("## Soul");
        expect(callArgs.systemPrompt).toContain("## Agent Memory");
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("agent WITHOUT identity (no soul, instructions, memory) still exits with no_assignment", async () => {
      // Agent with empty strings should also exit gracefully
      const store = createStoreWithAgentForExec({
        taskId: undefined,
        soul: "",
        instructionsText: "",
        memory: "",
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result).toBeDefined();
      expect(result.status).toBe("completed");
      // Should NOT create a session for agents without identity
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
      expect(result.resultJson).toEqual({ reason: "no_assignment" });
    });

    it("identity agent without task includes messaging tools when messageStore is available", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const messageStore = {
        setMessageToAgentHook: vi.fn(),
        getInbox: vi.fn().mockReturnValue([]),
        markAllAsRead: vi.fn(),
      } as unknown as MessageStore;

      const monitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      const callArgs = mockedCreateFnAgent.mock.calls[0]![0]!;
      const toolNames = callArgs.customTools!.map((tool: any) => tool.name);

      // Should have messaging tools when messageStore is available
      expect(toolNames).toContain("fn_send_message");
      expect(toolNames).toContain("fn_read_messages");
    });

    it("identity agent without task does NOT include messaging tools when messageStore is unavailable", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      const callArgs = mockedCreateFnAgent.mock.calls[0]![0]!;
      const toolNames = callArgs.customTools!.map((tool: any) => tool.name);

      // Should NOT have messaging tools when messageStore is not available
      expect(toolNames).not.toContain("fn_send_message");
      expect(toolNames).not.toContain("fn_read_messages");
    });

    it("identity agent without task fetches messages and includes them in prompt for timer trigger", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const messages = [
        createMessage({
          id: "msg-notask-1",
          fromId: "user-1",
          content: "Please check the task board",
        }),
        createMessage({
          id: "msg-notask-2",
          fromId: "agent-5",
          content: "Delegating FN-100 to you",
        }),
      ];

      const messageStore = {
        setMessageToAgentHook: vi.fn(),
        getInbox: vi.fn().mockReturnValue(messages),
        markAllAsRead: vi.fn(),
      } as unknown as MessageStore;

      const monitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "timer",
        triggerDetail: "scheduled",
      });

      expect(result.status).toBe("completed");
      // Messages should be fetched for no-task runs too
      expect(messageStore.getInbox).toHaveBeenCalledWith("agent-001", "agent", { read: false, limit: 10 });
      // Messages should be marked as read after successful execution
      expect(messageStore.markAllAsRead).toHaveBeenCalledWith("agent-001", "agent");

      // Verify execution prompt included the messages
      const promptCalls = mockSession.prompt.mock.calls;
      expect(promptCalls.length).toBeGreaterThan(0);
      const executionPrompt = promptCalls[promptCalls.length - 1][0];
      expect(executionPrompt).toContain("Pending Messages:");
      expect(executionPrompt).toContain("Please check the task board");
      expect(executionPrompt).toContain("Delegating FN-100 to you");
    });
  });

  describe("blocked-task heartbeat: runs through without early exit", () => {
    it("invokes the model when task is blocked (no early exit)", async () => {
      const store = createStoreWithAgentForExec({ taskId: "FN-BLOCKED" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const taskDetail = {
        id: "FN-BLOCKED",
        title: "Blocked Task",
        description: "Blocked task description",
        prompt: "",
        status: "queued",
        blockedBy: "FN-DEP-1",
        comments: [],
        steeringComments: [],
        steps: [],
        column: "todo",
        dependencies: [],
        log: [],
        attachments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as TaskDetail;

      mockTaskStore = createMockTaskStore({ getTask: vi.fn().mockResolvedValue(taskDetail) });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      // The heartbeat must fall through to model invocation — no early exit reason
      expect(result.resultJson).not.toEqual(expect.objectContaining({ reason: "blocked" }));
      expect(result.resultJson).not.toEqual(expect.objectContaining({ reason: "blocked_duplicate" }));
      expect(mockedCreateFnAgent).toHaveBeenCalled();
      expect(mockSession.prompt).toHaveBeenCalled();
    });

    it("includes blockedBy in the prompt context when task is blocked", async () => {
      const store = createStoreWithAgentForExec({ taskId: "FN-BLOCKED" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const taskDetail = {
        id: "FN-BLOCKED",
        title: "Blocked by dependency",
        description: "Task blocked on FN-DEP-99",
        prompt: "",
        status: "queued",
        blockedBy: "FN-DEP-99",
        comments: [],
        steeringComments: [],
        steps: [],
        column: "todo",
        dependencies: [],
        log: [],
        attachments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as TaskDetail;

      mockTaskStore = createMockTaskStore({ getTask: vi.fn().mockResolvedValue(taskDetail) });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      const promptCall = mockSession.prompt.mock.calls[0]?.[0] as string | undefined;
      expect(promptCall).toBeDefined();
      expect(promptCall).toContain("FN-DEP-99");
    });
  });

  // ── Utility Lane Independence Regression ─────────────────────────────────────
  // FN-1727: Heartbeat runs must execute on the control-plane (utility) lane
  // and must NOT consume task-lane semaphore slots. This test proves that
  // heartbeat execution completes successfully even when task execution
  // slots are saturated (e.g., maxConcurrent: 0 or all slots occupied).
  // The utility AI helper path must remain responsive under task-lane pressure.
  describe("slot-saturation: heartbeat runs on utility lane independent of task-lane semaphore", () => {
    it("executes heartbeat successfully while task-lane semaphore is saturated", async () => {
      // Import AgentSemaphore directly to create a saturated slot fixture
      const { AgentSemaphore } = await import("../concurrency.js");

      // Create a semaphore with maxConcurrent=0 to simulate fully saturated state
      // The defensive guard in AgentSemaphore.limit returns minimum 1, so we
      // use a static limit of 0 and manually acquire to simulate saturation.
      const taskLaneSemaphore = new AgentSemaphore(0);

      // Acquire the single available slot to saturate task lanes
      await taskLaneSemaphore.acquire();

      // Verify the semaphore is saturated (no available slots)
      expect(taskLaneSemaphore.availableCount).toBe(0);
      expect(taskLaneSemaphore.activeCount).toBe(1);

      // Create the heartbeat monitor (it does NOT receive the task-lane semaphore)
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      // Execute heartbeat while task lanes are saturated
      // This MUST succeed because heartbeat runs on the utility lane
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      // CRITICAL ASSERTIONS:
      // 1. Heartbeat completed successfully (proves it didn't wait for task-lane slot)
      expect(result).toBeDefined();
      expect(result.status).toBe("completed");

      // 2. Agent session was created (proves execution proceeded)
      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();

      // 3. Semaphore saturation is still held (proves heartbeat didn't consume task-lane slot)
      expect(taskLaneSemaphore.activeCount).toBe(1);

      // 4. Semaphore available count is still 0 (still saturated from task-lane perspective)
      expect(taskLaneSemaphore.availableCount).toBe(0);

      // Cleanup: release the task-lane slot
      taskLaneSemaphore.release();
      expect(taskLaneSemaphore.activeCount).toBe(0);
    });

    it("completes on_demand heartbeat while task-lane slots are fully occupied", async () => {
      const { AgentSemaphore } = await import("../concurrency.js");

      // Simulate multiple task-lane agents holding all slots
      const taskLaneSemaphore = new AgentSemaphore(2);

      // Saturate both slots with "task-lane agents"
      await taskLaneSemaphore.acquire(); // Agent 1
      await taskLaneSemaphore.acquire(); // Agent 2

      expect(taskLaneSemaphore.availableCount).toBe(0);

      // Now execute heartbeat - it should complete without waiting
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const startTime = Date.now();
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });
      const elapsed = Date.now() - startTime;

      // Should complete quickly (not blocked by semaphore wait)
      expect(elapsed).toBeLessThan(500);

      // Heartbeat should succeed
      expect(result.status).toBe("completed");

      // Task-lane slots should remain occupied
      expect(taskLaneSemaphore.activeCount).toBe(2);

      // Cleanup
      taskLaneSemaphore.release();
      taskLaneSemaphore.release();
    });
  });

  describe("executeHeartbeat - message processing", () => {
    it("keeps message_received wake reason when wake-on-message inbox is non-empty", async () => {
      vi.mocked(heartbeatLog.log).mockClear();
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const messages = [
        createMessage({
          id: "msg-1",
          fromId: "agent-2",
          fromType: "agent",
          content: "Hello from agent-2",
          createdAt: "2024-01-15T10:30:00.000Z",
        }),
        createMessage({
          id: "msg-2",
          fromId: "user-1",
          content: "Hello from user",
          createdAt: "2024-01-15T11:00:00.000Z",
        }),
      ];

      const messageStore = {
        setMessageToAgentHook: vi.fn(),
        getInbox: vi.fn().mockReturnValue(messages),
        markAllAsRead: vi.fn(),
      } as unknown as MessageStore;

      const monitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "on_demand",
        triggerDetail: "wake-on-message",
        wakeMessage: {
          messageId: "msg-1",
          fromType: "user",
          fromId: "user-1",
          forced: false,
          createdAt: "2024-01-15T10:30:00.000Z",
        },
      });

      expect(result.status).toBe("completed");
      expect(mockedCreateFnAgent).toHaveBeenCalled();
      expect(messageStore.getInbox).toHaveBeenCalledWith("agent-001", "agent", { read: false, limit: 10 });

      // Verify execution prompt (passed to promptWithFallback) included the messages
      // The execution prompt is passed to session.prompt by promptWithFallback mock
      const promptCalls = mockSession.prompt.mock.calls;
      expect(promptCalls.length).toBeGreaterThan(0);
      const executionPrompt = promptCalls[promptCalls.length - 1][0];
      expect(executionPrompt).toContain("Pending Messages:");
      expect(executionPrompt).toContain("[id: msg-1] [from: agent:agent-2] Hello from agent-2");
      expect(executionPrompt).toContain("[id: msg-2] [from: user:user-1] Hello from user");
      // Task-scoped prompts must include Wake Delta + Heartbeat Procedure so
      // the agent re-runs its procedure each tick instead of grinding on the
      // assigned task (paperclip-parity).
      expect(executionPrompt).toContain("## Wake Delta");
      expect(executionPrompt).toContain("wake reason: message_received");
      expect(executionPrompt).toContain("- inbox snapshot: 2 message(s)");
      expect(executionPrompt).toContain("wake trigger source: message msg-1 from user:user-1, still unread");
      expect(executionPrompt).toContain("- pending messages: 2");
      expect(executionPrompt).toContain("autonomous heartbeat run");
      expect(executionPrompt).toContain(HEARTBEAT_PROCEDURE);
      expect(executionPrompt).toContain("do not re-read PROMPT.md to advance it");
      expect(vi.mocked(heartbeatLog.log)).toHaveBeenCalledWith(
        expect.stringMatching(/\[wake-trigger-diagnostics\].*messageId=msg-1.*inboxUnreadCount=2.*wakeMessageStillUnread=true/),
      );
    });

    it("annotates wake-on-message with already-consumed reason when inbox snapshot is empty", async () => {
      vi.mocked(heartbeatLog.log).mockClear();
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const messageStore = {
        setMessageToAgentHook: vi.fn(),
        getInbox: vi.fn().mockReturnValue([]),
        markAllAsRead: vi.fn(),
      } as unknown as MessageStore;

      const monitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "on_demand",
        triggerDetail: "wake-on-message",
        wakeMessage: {
          messageId: "msg-empty-1",
          fromType: "user",
          fromId: "user-empty",
          forced: false,
          createdAt: "2024-01-15T12:00:00.000Z",
        },
      });

      expect(result.status).toBe("completed");
      const promptCalls = mockSession.prompt.mock.calls;
      const executionPrompt = promptCalls[promptCalls.length - 1][0];
      expect(executionPrompt).toContain("wake reason: message_received_already_consumed");
      expect(executionPrompt).toContain("- inbox snapshot: empty (already consumed)");
      expect(executionPrompt).toContain("wake trigger source: message msg-empty-1 from user:user-empty, already consumed at snapshot");
      expect(executionPrompt).toContain("- pending messages: 0");
      expect(executionPrompt).not.toContain("wake reason: message_received\n");
      expect(vi.mocked(heartbeatLog.log)).toHaveBeenCalledWith(
        expect.stringMatching(/\[wake-trigger-diagnostics\].*messageId=msg-empty-1.*inboxUnreadCount=0.*wakeMessageStillUnread=false/),
      );
    });

    it("annotates forced wake-on-message with urgent already-consumed reason when inbox snapshot is empty", async () => {
      vi.mocked(heartbeatLog.log).mockClear();
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const messageStore = {
        setMessageToAgentHook: vi.fn(),
        getInbox: vi.fn().mockReturnValue([]),
        markAllAsRead: vi.fn(),
      } as unknown as MessageStore;

      const monitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "on_demand",
        triggerDetail: "wake-on-message-forced",
        wakeMessage: {
          messageId: "msg-forced-1",
          fromType: "user",
          fromId: "user-forced",
          forced: true,
          createdAt: "2024-01-15T13:00:00.000Z",
        },
      });

      expect(result.status).toBe("completed");
      const promptCalls = mockSession.prompt.mock.calls;
      const executionPrompt = promptCalls[promptCalls.length - 1][0];
      expect(executionPrompt).toContain("wake reason: message_received_urgent_already_consumed");
      expect(executionPrompt).toContain("- inbox snapshot: empty (already consumed)");
      expect(executionPrompt).toContain("wake trigger source: message msg-forced-1 from user:user-forced (forced), already consumed at snapshot");
      expect(executionPrompt).toContain("- pending messages: 0");
      expect(vi.mocked(heartbeatLog.log)).toHaveBeenCalledWith(
        expect.stringMatching(/\[wake-trigger-diagnostics\].*messageId=msg-forced-1.*forced=true.*inboxUnreadCount=0.*wakeMessageStillUnread=false/),
      );
    });

    it("substitutes per-agent heartbeatProcedurePath content for the default procedure", async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "fn-hb-procedure-"));
      try {
        const customProcedure = "## Custom CEO Procedure\n\n1. Review reports\n2. Update strategy\n3. Exit";
        writeFileSync(join(tmpRoot, "MY-PROCEDURE.md"), customProcedure, "utf-8");

        const store = createStoreWithAgentForExec({
          heartbeatProcedurePath: "MY-PROCEDURE.md",
        });
        const mockSession = createMockAgentSession();
        mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: tmpRoot });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result.status).toBe("completed");
        const promptCalls = mockSession.prompt.mock.calls;
        expect(promptCalls.length).toBeGreaterThan(0);
        const executionPrompt = promptCalls[promptCalls.length - 1][0];

        // Custom procedure should appear; default constant should not.
        expect(executionPrompt).toContain("## Custom CEO Procedure");
        expect(executionPrompt).toContain("1. Review reports");
        expect(executionPrompt).not.toContain(HEARTBEAT_PROCEDURE);
        // Wake Delta still rendered.
        expect(executionPrompt).toContain("## Wake Delta");

        const savedRun = await store.getRunDetail("agent-001", result.id);
        expect(savedRun?.heartbeatProcedureSource).toBe("custom");
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("falls back to default procedure when heartbeatProcedurePath is invalid (traversal)", async () => {
      const store = createStoreWithAgentForExec({
        heartbeatProcedurePath: "../escape.md",
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result.status).toBe("completed");
      const promptCalls = mockSession.prompt.mock.calls;
      const executionPrompt = promptCalls[promptCalls.length - 1][0];
      // Invalid path → fall back to the default constant.
      expect(executionPrompt).toContain(HEARTBEAT_PROCEDURE);
    });

    it("does not include message section when no unread messages", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const messageStore = {
        setMessageToAgentHook: vi.fn(),
        getInbox: vi.fn().mockReturnValue([]),
        markAllAsRead: vi.fn(),
      } as unknown as MessageStore;

      const monitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "on_demand",
        triggerDetail: "wake-on-message",
      });

      expect(result.status).toBe("completed");

      // Verify prompt did NOT include pending messages section
      // Note: without wake-on-message trigger, no messages are fetched
      // so the prompt won't have the Pending Messages section at all
    });

    it("marks messages as read after successful heartbeat execution", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const messages = [
        createMessage({
          id: "msg-1",
          fromId: "agent-2",
          content: "Hello from agent-2",
        }),
      ];

      const messageStore = {
        setMessageToAgentHook: vi.fn(),
        getInbox: vi.fn().mockReturnValue(messages),
        markAllAsRead: vi.fn(),
      } as unknown as MessageStore;

      const monitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "on_demand",
        triggerDetail: "wake-on-message",
      });

      expect(result.status).toBe("completed");
      expect(messageStore.markAllAsRead).toHaveBeenCalledWith("agent-001", "agent");
    });

    it("does not mark messages as read on failed heartbeat execution", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockSession.prompt = vi.fn().mockRejectedValue(new Error("Execution failed"));
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const messages = [
        createMessage({
          id: "msg-1",
          fromId: "agent-2",
          content: "Hello from agent-2",
        }),
      ];

      const messageStore = {
        setMessageToAgentHook: vi.fn(),
        getInbox: vi.fn().mockReturnValue(messages),
        markAllAsRead: vi.fn(),
      } as unknown as MessageStore;

      const monitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "on_demand",
        triggerDetail: "wake-on-message",
      });

      expect(result.status).toBe("failed");
      expect(messageStore.markAllAsRead).not.toHaveBeenCalled();
    });

    it("fetches messages for timer-triggered runs when messageStore is available", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const messages = [
        createMessage({
          id: "msg-1",
          fromId: "agent-2",
          content: "Reminder about task FN-001",
        }),
      ];

      const messageStore = {
        setMessageToAgentHook: vi.fn(),
        getInbox: vi.fn().mockReturnValue(messages),
        markAllAsRead: vi.fn(),
      } as unknown as MessageStore;

      const monitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      // Use a timer trigger (not wake-on-message)
      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "timer",
        triggerDetail: "scheduled",
      });

      expect(result.status).toBe("completed");
      // Messages should be fetched even for timer triggers
      expect(messageStore.getInbox).toHaveBeenCalledWith("agent-001", "agent", { read: false, limit: 10 });
      // Messages should be marked as read after successful execution
      expect(messageStore.markAllAsRead).toHaveBeenCalledWith("agent-001", "agent");

      // Verify execution prompt included the messages
      const promptCalls = mockSession.prompt.mock.calls;
      expect(promptCalls.length).toBeGreaterThan(0);
      const executionPrompt = promptCalls[promptCalls.length - 1][0];
      expect(executionPrompt).toContain("Pending Messages:");
      expect(executionPrompt).toContain("Reminder about task FN-001");
    });

    it("fetches messages for assignment-triggered runs when messageStore is available", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const messages = [
        createMessage({
          id: "msg-assign-1",
          fromId: "user-1",
          content: "Please work on this task",
        }),
      ];

      const messageStore = {
        setMessageToAgentHook: vi.fn(),
        getInbox: vi.fn().mockReturnValue(messages),
        markAllAsRead: vi.fn(),
      } as unknown as MessageStore;

      const monitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      // Use an assignment trigger
      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "assignment",
        triggerDetail: "task-assigned",
      });

      expect(result.status).toBe("completed");
      expect(messageStore.getInbox).toHaveBeenCalledWith("agent-001", "agent", { read: false, limit: 10 });
      expect(messageStore.markAllAsRead).toHaveBeenCalledWith("agent-001", "agent");

      // Verify execution prompt included the messages
      const promptCalls = mockSession.prompt.mock.calls;
      expect(promptCalls.length).toBeGreaterThan(0);
      const executionPrompt = promptCalls[promptCalls.length - 1][0];
      expect(executionPrompt).toContain("Pending Messages:");
      expect(executionPrompt).toContain("Please work on this task");
    });

    it("fetches messages for on-demand runs without wake-on-message trigger", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const messages = [
        createMessage({
          id: "msg-od-1",
          fromId: "agent-3",
          content: "Status update: task FN-002 is complete",
        }),
      ];

      const messageStore = {
        setMessageToAgentHook: vi.fn(),
        getInbox: vi.fn().mockReturnValue(messages),
        markAllAsRead: vi.fn(),
      } as unknown as MessageStore;

      const monitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      // Use on-demand trigger without wake-on-message
      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "on_demand",
        triggerDetail: "manual",
      });

      expect(result.status).toBe("completed");
      expect(messageStore.getInbox).toHaveBeenCalledWith("agent-001", "agent", { read: false, limit: 10 });
      expect(messageStore.markAllAsRead).toHaveBeenCalledWith("agent-001", "agent");

      // Verify execution prompt included the messages
      const promptCalls = mockSession.prompt.mock.calls;
      expect(promptCalls.length).toBeGreaterThan(0);
      const executionPrompt = promptCalls[promptCalls.length - 1][0];
      expect(executionPrompt).toContain("Pending Messages:");
      expect(executionPrompt).toContain("Status update: task FN-002 is complete");
    });

    it("still fetches messages for wake-on-message triggers", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const messages = [
        createMessage({
          id: "msg-wom-1",
          fromId: "agent-2",
          content: "Hello from agent-2",
        }),
      ];

      const messageStore = {
        setMessageToAgentHook: vi.fn(),
        getInbox: vi.fn().mockReturnValue(messages),
        markAllAsRead: vi.fn(),
      } as unknown as MessageStore;

      const monitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "on_demand",
        triggerDetail: "wake-on-message",
      });

      expect(result.status).toBe("completed");
      expect(messageStore.getInbox).toHaveBeenCalledWith("agent-001", "agent", { read: false, limit: 10 });
      expect(messageStore.markAllAsRead).toHaveBeenCalledWith("agent-001", "agent");

      // Verify execution prompt included the messages
      const promptCalls = mockSession.prompt.mock.calls;
      expect(promptCalls.length).toBeGreaterThan(0);
      const executionPrompt = promptCalls[promptCalls.length - 1][0];
      expect(executionPrompt).toContain("Pending Messages:");
      expect(executionPrompt).toContain("Hello from agent-2");
    });

    describe("end-to-end message flow", () => {
      it("proves wake-on-message can surface a user message and send a linked reply", async () => {
        const messages: Map<string, Message[]> = new Map();
        let messageCounter = 0;

        const fakeMessageStore = {
          setMessageToAgentHook: vi.fn(),
          sendMessage: vi.fn((input: Omit<Message, "id" | "read" | "createdAt" | "updatedAt">) => {
            const id = `msg-${++messageCounter}`;
            const createdAt = new Date().toISOString();
            const msg: Message = {
              id,
              ...input,
              read: false,
              createdAt,
              updatedAt: createdAt,
            };

            const key = `${input.toId}:${input.toType}`;
            const inbox = messages.get(key) || [];
            inbox.push(msg);
            messages.set(key, inbox);
            return msg;
          }),
          getInbox: vi.fn((participantId: string, participantType: string, opts?: { read?: boolean }) => {
            const key = `${participantId}:${participantType}`;
            const inbox = messages.get(key) || [];
            if (opts?.read === false) return inbox.filter((message) => !message.read);
            return inbox;
          }),
          getMailbox: vi.fn((participantId: string, participantType: string) => {
            const key = `${participantId}:${participantType}`;
            const inbox = messages.get(key) || [];
            return { unreadCount: inbox.filter((message) => !message.read).length, messages: inbox };
          }),
          markAllAsRead: vi.fn((participantId: string, participantType: string) => {
            const key = `${participantId}:${participantType}`;
            const inbox = messages.get(key) || [];
            inbox.forEach((message) => {
              message.read = true;
            });
            messages.set(key, inbox);
          }),
        } as unknown as MessageStore;

        const inboundFromUser = fakeMessageStore.sendMessage({
          fromId: "dashboard",
          fromType: "user",
          toId: "agent-beta",
          toType: "agent",
          content: "Can you post a status update?",
          type: "user-to-agent",
        });

        const store = createStoreWithAgentForExec({
          id: "agent-beta",
          name: "Agent Beta",
          state: "active",
          taskId: "FN-001",
        });
        const mockSession = createMockAgentSession();
        mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({
          store,
          messageStore: fakeMessageStore,
          taskStore: mockTaskStore,
          rootDir: "/tmp",
        });

        const result = await monitor.executeHeartbeat({
          agentId: "agent-beta",
          source: "on_demand",
          triggerDetail: "wake-on-message",
        });

        expect(result.status).toBe("completed");

        const promptCalls = mockSession.prompt.mock.calls;
        const executionPrompt = promptCalls[promptCalls.length - 1]?.[0] as string;
        expect(executionPrompt).toContain("Pending Messages:");
        expect(executionPrompt).toContain(`[id: ${inboundFromUser.id}]`);
        expect(executionPrompt).toContain("dashboard");

        const callArgs = mockedCreateFnAgent.mock.calls[0]![0]!;
        const sendMessageTool = callArgs.customTools?.find((tool: { name: string }) => tool.name === "fn_send_message");
        expect(sendMessageTool).toBeDefined();

        for (const [index, alias] of ["dashboard", "user:dashboard", "User: user:dashboard"].entries()) {
          await sendMessageTool!.execute(
            `tool-call-${index}`,
            {
              to_id: alias,
              content: `Status: I am on it. (${index})`,
              type: "agent-to-user",
              reply_to_message_id: inboundFromUser.id,
            },
            undefined,
            undefined,
            {} as any,
          );
        }

        const dashboardInbox = fakeMessageStore.getInbox("dashboard", "user");
        for (const index of [0, 1, 2]) {
          const linkedReply = dashboardInbox.find((message) => message.content === `Status: I am on it. (${index})`);
          expect(linkedReply?.metadata).toEqual({ replyTo: { messageId: inboundFromUser.id } });
        }

        monitor.stop();
      });
    });
  });

  describe("executeHeartbeat - inbox selection", () => {
    const makeInboxSelection = (
      taskId: string,
      priority: "in_progress" | "todo" | "blocked" = "todo",
      sourceMetadata?: Record<string, unknown>,
    ) => {
      const now = new Date().toISOString();
      return {
        task: {
          id: taskId,
          description: `Inbox task ${taskId}`,
          column: priority === "in_progress" ? "in-progress" : "todo",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: now,
          updatedAt: now,
          ...(sourceMetadata ? { sourceMetadata } : {}),
        },
        priority,
        reason: `selected:${priority}`,
      } as any;
    };

    it("when agent has no taskId, inbox selects a todo task and assigns it", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined });
      const selectNextTaskForAgent = vi.fn().mockResolvedValue(makeInboxSelection("FN-INBOX", "todo"));
      mockTaskStore = createMockTaskStore({
        selectNextTaskForAgent,
        getTask: vi.fn().mockResolvedValue({
          id: "FN-INBOX",
          title: "Inbox Task",
          description: "Inbox-selected task",
          prompt: "",
          steps: [],
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail),
      });

      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(selectNextTaskForAgent).toHaveBeenCalledWith("agent-001", { id: "agent-001", role: "executor" });
      expect(store.assignTask).toHaveBeenCalledWith("agent-001", "FN-INBOX", expect.objectContaining({ agentId: "agent-001" }));
      expect(mockTaskStore.getTask).toHaveBeenCalledWith("FN-INBOX");
    });

    it("explicit taskId override takes precedence over inbox selection", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined });
      const selectNextTaskForAgent = vi.fn().mockResolvedValue(makeInboxSelection("FN-INBOX", "todo"));
      mockTaskStore = createMockTaskStore({ selectNextTaskForAgent });

      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "on_demand",
        taskId: "FN-EXPLICIT",
      });

      expect(selectNextTaskForAgent).not.toHaveBeenCalled();
      expect(mockTaskStore.getTask).toHaveBeenCalledWith("FN-EXPLICIT");
    });

    it("agent's existing taskId takes precedence over inbox selection", async () => {
      const store = createStoreWithAgentForExec({ taskId: "FN-EXISTING" });
      const selectNextTaskForAgent = vi.fn().mockResolvedValue(makeInboxSelection("FN-INBOX", "todo"));
      mockTaskStore = createMockTaskStore({ selectNextTaskForAgent });

      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(selectNextTaskForAgent).not.toHaveBeenCalled();
      expect(mockTaskStore.getTask).toHaveBeenCalledWith("FN-EXISTING");
    });

    it("allows non-executor inbox selection when override metadata is present", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined, role: "reviewer" });
      const selectNextTaskForAgent = vi.fn().mockResolvedValue(
        makeInboxSelection("FN-INBOX", "todo", { executorRoleOverride: true }),
      );
      mockTaskStore = createMockTaskStore({
        selectNextTaskForAgent,
        getTask: vi.fn().mockResolvedValue({
          id: "FN-INBOX",
          title: "Inbox Task",
          description: "Inbox-selected task",
          prompt: "",
          steps: [],
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sourceMetadata: { executorRoleOverride: true },
        } as unknown as TaskDetail),
      });

      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(selectNextTaskForAgent).toHaveBeenCalledWith("agent-001", { id: "agent-001", role: "reviewer" });
      expect(store.assignTask).toHaveBeenCalledWith("agent-001", "FN-INBOX", expect.objectContaining({ agentId: "agent-001" }));
      expect(result.resultJson).toEqual(expect.objectContaining({ reason: "inbox_selected", taskId: "FN-INBOX" }));
    });

    it("when inbox returns null, heartbeat completes with no_assignment", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined });
      const selectNextTaskForAgent = vi.fn().mockResolvedValue(null);
      mockTaskStore = createMockTaskStore({ selectNextTaskForAgent });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(selectNextTaskForAgent).toHaveBeenCalledWith("agent-001", { id: "agent-001", role: "executor" });
      expect(result.resultJson).toEqual({ reason: "no_assignment" });
    });

    it("records inbox selection metadata in resultJson", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined });
      mockTaskStore = createMockTaskStore({
        selectNextTaskForAgent: vi.fn().mockResolvedValue(makeInboxSelection("FN-INBOX", "todo")),
        getTask: vi.fn().mockResolvedValue({
          id: "FN-INBOX",
          title: "Inbox Task",
          description: "Inbox-selected task",
          prompt: "",
          steps: [],
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail),
      });

      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result.resultJson).toEqual(expect.objectContaining({
        reason: "inbox_selected",
        priority: "todo",
        taskId: "FN-INBOX",
      }));
    });

    it("supports in-progress inbox selections before todo", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined });
      mockTaskStore = createMockTaskStore({
        selectNextTaskForAgent: vi.fn().mockResolvedValue(makeInboxSelection("FN-RESUME", "in_progress")),
        getTask: vi.fn().mockResolvedValue({
          id: "FN-RESUME",
          title: "Resume task",
          description: "Resume in-progress work",
          prompt: "",
          steps: [],
          column: "in-progress",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail),
      });

      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(mockTaskStore.getTask).toHaveBeenCalledWith("FN-RESUME");
      expect(result.resultJson).toEqual(expect.objectContaining({
        reason: "inbox_selected",
        priority: "in_progress",
        taskId: "FN-RESUME",
      }));
    });

    it("gracefully skips inbox selection when checkoutTask throws", async () => {
      const store = createStoreWithAgentForExec({ taskId: undefined });
      const selectNextTaskForAgent = vi.fn().mockResolvedValue(makeInboxSelection("FN-CHECKOUT", "todo"));
      const checkoutTask = vi.fn().mockRejectedValue(new Error("Task is already checked out"));
      mockTaskStore = createMockTaskStore({
        selectNextTaskForAgent,
        checkoutTask: checkoutTask as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(selectNextTaskForAgent).toHaveBeenCalledWith("agent-001", { id: "agent-001", role: "executor" });
      expect(checkoutTask).toHaveBeenCalledWith("FN-CHECKOUT", "agent-001", expect.objectContaining({ agentId: "agent-001" }));
      expect(result.resultJson).toEqual({ reason: "no_assignment" });
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    });
  });

  describe("execution", () => {
    it("no-task system prompt does not reference fn_task_log or task_document tools", () => {
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).not.toContain("fn_task_log");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).not.toContain("fn_task_document_write");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).not.toContain("fn_task_document_read");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).not.toContain("task_document");
    });

    it("no-task system prompt references only available tools", () => {
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain("fn_task_create");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain("fn_list_agents");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain("fn_delegate_task");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain("fn_send_message");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain("fn_read_messages");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain("fn_memory_search");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain("fn_memory_get");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain("fn_memory_append");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain("fn_heartbeat_done");
    });

    it("no-task heartbeat procedure aligns with ambient tools", () => {
      expect(HEARTBEAT_NO_TASK_PROCEDURE).not.toContain("fn_task_log");
      expect(HEARTBEAT_NO_TASK_PROCEDURE).not.toContain("fn_task_document_write");
      expect(HEARTBEAT_NO_TASK_PROCEDURE).toContain("fn_task_create");
      expect(HEARTBEAT_NO_TASK_PROCEDURE).toContain("fn_delegate_task");
      expect(HEARTBEAT_NO_TASK_PROCEDURE).toContain("fn_memory_append");
    });

    it("task-scoped system prompt still references fn_task_log and fn_task_document tools", () => {
      expect(HEARTBEAT_SYSTEM_PROMPT).toContain("fn_task_log");
      expect(HEARTBEAT_SYSTEM_PROMPT).toContain("fn_task_document_write");
      expect(HEARTBEAT_SYSTEM_PROMPT).toContain("fn_task_document tools");
    });

    it("both prompts include memory boundaries section", () => {
      expect(HEARTBEAT_SYSTEM_PROMPT).toContain("## Memory Boundaries");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain("## Memory Boundaries");
    });

    it("both system prompts include durable critical rules that survive custom HEARTBEAT.md", () => {
      for (const prompt of [HEARTBEAT_SYSTEM_PROMPT, HEARTBEAT_NO_TASK_SYSTEM_PROMPT]) {
        expect(prompt).toContain("## Critical Rules");
        expect(prompt).toContain("Do NOT implement task body work");
        expect(prompt).toContain("Checkout/claim conflict");
        expect(prompt).toContain("Blocked-task dedup");
        expect(prompt).toContain("coordination inventory");
      }
    });

    it("strict procedures include disposition checklist and scoped-wake language", () => {
      expect(HEARTBEAT_PROCEDURE).toContain("Final disposition checklist");
      expect(HEARTBEAT_PROCEDURE).toContain("Scoped-wake fast path");
      expect(HEARTBEAT_PROCEDURE).toContain("Blocked dedup");
      expect(HEARTBEAT_NO_TASK_PROCEDURE).toContain("Final disposition checklist");
      expect(HEARTBEAT_NO_TASK_PROCEDURE).not.toContain("fn_task_log");
    });

    it("both prompts instruct replies to include reply_to_message_id", () => {
      expect(HEARTBEAT_SYSTEM_PROMPT).toContain("reply_to_message_id");
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain("reply_to_message_id");
    });

    it("both heartbeat procedures prioritize inbox processing before wake delta", () => {
      expect(HEARTBEAT_PROCEDURE).toContain("process unread/pending messages before any other action");
      expect(HEARTBEAT_NO_TASK_PROCEDURE).toContain("process unread/pending messages before any other action");
      expect(HEARTBEAT_PROCEDURE.indexOf("**Inbox**")).toBeLessThan(HEARTBEAT_PROCEDURE.indexOf("**Wake delta**"));
      expect(HEARTBEAT_NO_TASK_PROCEDURE.indexOf("**Inbox**")).toBeLessThan(HEARTBEAT_NO_TASK_PROCEDURE.indexOf("**Wake delta**"));
    });

    it("heartbeat procedures include scope-discipline guidance", () => {
      expect(HEARTBEAT_PROCEDURE).toContain("executor-class");
      expect(HEARTBEAT_PROCEDURE).toContain("blocked");
      expect(HEARTBEAT_PROCEDURE).toContain("coordination-class");
      expect(HEARTBEAT_PROCEDURE).toContain("do not re-read PROMPT.md to advance it");
      expect(HEARTBEAT_PROCEDURE).toContain("avoid re-planning it");

      const inboxIndex = HEARTBEAT_PROCEDURE.indexOf("**Inbox**");
      const wakeDeltaIndex = HEARTBEAT_PROCEDURE.indexOf("**Wake delta**");
      const classifyIndex = HEARTBEAT_PROCEDURE.indexOf("**Classify the bound task**");
      const selfCheckIndex = HEARTBEAT_PROCEDURE.indexOf("**Per-tick self-check**");
      const exitIndex = HEARTBEAT_PROCEDURE.indexOf("fn_heartbeat_done");
      expect(classifyIndex).toBeGreaterThan(inboxIndex);
      expect(classifyIndex).toBeGreaterThan(wakeDeltaIndex);
      expect(selfCheckIndex).toBeGreaterThan(classifyIndex);
      expect(selfCheckIndex).toBeLessThan(exitIndex);

      expect(HEARTBEAT_NO_TASK_PROCEDURE).toContain("coordination-class");
      expect(HEARTBEAT_NO_TASK_PROCEDURE).not.toContain("executor-class");
      expect(HEARTBEAT_NO_TASK_PROCEDURE).not.toContain("do not re-read PROMPT.md to advance it");
    });

    it("no-task system prompt processing messages section does not reference fn_task_log", () => {
      const processingMessagesSection = HEARTBEAT_NO_TASK_SYSTEM_PROMPT.split("## Processing Messages")[1] ?? "";
      expect(processingMessagesSection).not.toContain("fn_task_log");
    });

    it("creates session with enriched system prompt and expected tools", async () => {
      const store = createStoreWithAgentForExec({
        soul: "Act like a practical teammate who prioritizes clarity.",
        memory: "Recent runs found flaky tests in integration suites.",
        instructionsText: "Always log blockers with actionable next steps.",
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp/test" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      const callArgs = mockedCreateFnAgent.mock.calls[0]![0];
      expect(callArgs.cwd).toBe("/tmp/worktree-fn-001");
      expect(callArgs.systemPrompt).toContain(HEARTBEAT_SYSTEM_PROMPT);
      expect(callArgs.systemPrompt).toContain("## Soul");
      expect(callArgs.systemPrompt).toContain("Act like a practical teammate who prioritizes clarity.");
      expect(callArgs.systemPrompt).toContain("## Agent Memory");
      expect(callArgs.systemPrompt).toContain("Recent runs found flaky tests in integration suites.");
      expect(callArgs.systemPrompt).toContain("Always log blockers with actionable next steps.");
      expect(callArgs.systemPrompt).toContain("## Project Memory");
      expect(callArgs.systemPrompt).toContain("fn_memory_search");
      expect(callArgs.systemPrompt).toContain("fn_task_log");
      expect(callArgs.systemPrompt).toContain("fn_task_document_write");
      expect(callArgs.tools).toBe("coding");
      /*
      FNXC:TaskAgentLog 2026-07-16-08:05:
      Heartbeat customTools include FN-8058 fn_task_logs_read after fn_task_log so durable agents can read agent-log.jsonl. Count stays exact so new tools fail loudly.

      FNXC:MissionToolParity 2026-07-18-12:40:
      FN-8294 adds the full Mission hierarchy surface (15 tools) to task-scoped heartbeat sessions via createMissionTools, after agent provisioning and before goal retrieval. Count rose 43→58; keep exact so new tools fail loudly.

      FNXC:Ideation 2026-07-18-14:05:
      FN-8295 mounts createIdeationTools (5 tools) immediately after missions on task-scoped and no-task heartbeats. Count rose 58→63.

      FNXC:ResearchMissionBridge 2026-07-18-16:35:
      FN-8297 adds fn_research_promote_finding on the Mission tool surface (after feature_link_task). Count rose 63→64.
      */
      // fn_artifact_register/list/view, agent config/provisioning, mission hierarchy, ideation, goals/evaluations/identity,
      // task read discovery (incl. logs_read), workflow discovery/authoring, task promotion, bounded research, clarification, web fetch, memory, and fn_heartbeat_done.
      expect(callArgs.customTools).toHaveLength(64);
      expect(callArgs.customTools!.map((tool) => tool.name)).toEqual([
        "fn_task_create",
        "fn_task_log",
        "fn_task_logs_read",
        "fn_task_document_write",
        "fn_task_document_read",
        "fn_artifact_register",
        "fn_artifact_list",
        "fn_artifact_view",
        "fn_list_agents",
        "fn_delegate_task",
        "fn_task_assign",
        "fn_get_agent_config",
        "fn_update_agent_config",
        "fn_agent_create",
        "fn_agent_delete",
        "fn_mission_list",
        "fn_mission_show",
        "fn_mission_create",
        "fn_mission_update",
        "fn_mission_delete",
        "fn_milestone_add",
        "fn_milestone_update",
        "fn_milestone_delete",
        "fn_slice_add",
        "fn_slice_activate",
        "fn_slice_delete",
        "fn_feature_add",
        "fn_feature_update",
        "fn_feature_delete",
        "fn_feature_link_task",
        "fn_research_promote_finding",
        "fn_ideation_list",
        "fn_ideation_show",
        "fn_ideation_start",
        "fn_ideation_diverge",
        "fn_ideation_converge",
        "fn_goal_list",
        "fn_goal_show",
        "fn_read_evaluations",
        "fn_update_identity",
        "fn_task_list",
        "fn_task_show",
        "fn_task_search",
        "fn_workflow_list",
        "fn_workflow_get",
        "fn_workflow_validate",
        "fn_workflow_create",
        "fn_workflow_update",
        "fn_workflow_delete",
        "fn_workflow_settings",
        "fn_trait_list",
        "fn_ask_question",
        "fn_research_run",
        "fn_research_list",
        "fn_research_get",
        "fn_research_cancel",
        "fn_research_retry",
        "fn_workflow_select",
        "fn_task_promote",
        "fn_web_fetch",
        "fn_memory_search",
        "fn_memory_get",
        "fn_memory_append",
        // fn_heartbeat_done is last (terminal tool)
        "fn_heartbeat_done",
      ]);
    });

    it("loads workspace memory into system prompt and identity snapshot when inline memory is empty", async () => {
      const rootDir = mkdtempSync(join(tmpdir(), "heartbeat-workspace-memory-"));
      mkdirSync(join(rootDir, ".fusion", "agent-memory", "agent-001"), { recursive: true });
      writeFileSync(
        join(rootDir, ".fusion", "agent-memory", "agent-001", "MEMORY.md"),
        "workspace memory for heartbeat",
        "utf-8",
      );

      try {
        const store = createStoreWithAgentForExec({
          memory: "",
          instructionsText: undefined,
          instructionsPath: undefined,
        });
        const mockSession = createMockAgentSession();
        mockedCreateFnAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        const callArgs = mockedCreateFnAgent.mock.calls[0]![0];
        expect(callArgs.systemPrompt).toContain("## Agent Memory");
        expect(callArgs.systemPrompt).toContain("workspace memory for heartbeat");

        const executionPrompt = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
        expect(executionPrompt).toMatch(/- memory: loaded \(\d+ chars, sha256:[a-f0-9]{8}, source: workspace\)/);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("includes memory instructions even when agent has no custom instructions", async () => {
      const store = createStoreWithAgentForExec({
        soul: undefined,
        memory: undefined,
        instructionsText: undefined,
        instructionsPath: undefined,
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp/test" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      const callArgs = mockedCreateFnAgent.mock.calls[0]![0];
      expect(callArgs.systemPrompt).toContain(HEARTBEAT_SYSTEM_PROMPT);
      expect(callArgs.systemPrompt).toContain("## Project Memory");
    });

    it("includes markdown instructions files plus soul in heartbeat system prompts", async () => {
      const rootDir = mkdtempSync(join(tmpdir(), "heartbeat-agent-instructions-"));
      writeFileSync(
        join(rootDir, "heartbeat-agent.md"),
        "# Heartbeat Playbook\n\nCheck messages first, then create focused follow-up tasks.",
      );

      try {
        const store = createStoreWithAgentForExec({
          instructionsPath: "heartbeat-agent.md",
          soul: "Operate like a calm, systems-minded operator.",
        });
        const taskStore = createMockTaskStore({
          getSettings: vi.fn().mockResolvedValue({ memoryEnabled: false }),
        } as Partial<TaskStore>);
        const mockSession = createMockAgentSession();
        mockedCreateFnAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore, rootDir });
        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        const callArgs = mockedCreateFnAgent.mock.calls[0]![0];
        expect(callArgs.systemPrompt).toContain(HEARTBEAT_SYSTEM_PROMPT);
        expect(callArgs.systemPrompt).toContain("## Soul");
        expect(callArgs.systemPrompt).toContain("Operate like a calm, systems-minded operator.");
        expect(callArgs.systemPrompt).toContain("# Heartbeat Playbook");
        expect(callArgs.systemPrompt).toContain("create focused follow-up tasks");
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("omits memory tools and instructions when project memory is disabled", async () => {
      const store = createStoreWithAgentForExec();
      const taskStore = createMockTaskStore({
        getSettings: vi.fn().mockResolvedValue({ memoryEnabled: false }),
      } as Partial<TaskStore>);
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/tmp/test" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      const callArgs = mockedCreateFnAgent.mock.calls[0]![0];
      const toolNames = callArgs.customTools!.map((tool: any) => tool.name);
      expect(callArgs.systemPrompt).not.toContain("## Project Memory");
      expect(toolNames).not.toContain("fn_memory_search");
      expect(toolNames).not.toContain("fn_memory_get");
      expect(toolNames).not.toContain("fn_memory_append");
    });

    it("wires session memory tools to read agent long-term, dreams, and daily layers", async () => {
      const store = createStoreWithAgentForExec({
        name: "CEO",
        memory: "Prioritize roadmap sequencing and delegate implementation follow-ups.",
      });
      const taskStore = createMockTaskStore({
        getSettings: vi.fn().mockResolvedValue({ memoryBackendType: "file" }),
      } as Partial<TaskStore>);
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/tmp/test" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      const callArgs = mockedCreateFnAgent.mock.calls[0]![0];
      const memorySearch = callArgs.customTools!.find((tool: any) => tool.name === "fn_memory_search") as any;
      const memoryGet = callArgs.customTools!.find((tool: any) => tool.name === "fn_memory_get") as any;
      const memoryAppend = callArgs.customTools!.find((tool: any) => tool.name === "fn_memory_append") as any;

      expect(memorySearch).toBeDefined();
      expect(memoryGet).toBeDefined();
      expect(memoryAppend).toBeDefined();

      await memoryAppend.execute("call-append-dream", {
        scope: "agent",
        layer: "daily",
        content: "- Daily delegation note from heartbeat test",
      }, undefined, undefined, undefined);
      appendFileSync(
        "/tmp/test/.fusion/agent-memory/agent-001/DREAMS.md",
        "\n- Dream delegation theme from heartbeat test\n",
        "utf-8",
      );

      const dreamsResult = await memorySearch.execute("call-search-1", {
        query: "dream delegation theme",
        limit: 5,
      }, undefined, undefined, undefined);
      const dailyResult = await memorySearch.execute("call-search-2", {
        query: "daily delegation note",
        limit: 5,
      }, undefined, undefined, undefined);

      expect(dreamsResult.content[0].text).toContain(".fusion/agent-memory/agent-001/DREAMS.md");
      expect(dailyResult.content[0].text).toContain(".fusion/agent-memory/agent-001/");

      const dreamsRead = await memoryGet.execute("call-get-1", {
        path: ".fusion/agent-memory/agent-001/DREAMS.md",
        startLine: 1,
        lineCount: 40,
      }, undefined, undefined, undefined);

      expect(dreamsRead.content[0].text).toContain("Dream delegation theme from heartbeat test");
    });

    it("includes document tools in heartbeat session", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp/test" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      const callArgs = mockedCreateFnAgent.mock.calls[0]![0];
      const toolNames = callArgs.customTools!.map((t: any) => t.name);
      expect(toolNames).toContain("fn_task_document_write");
      expect(toolNames).toContain("fn_task_document_read");
    });

    it("fn_heartbeat_done is the terminal tool (last in array)", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp/test" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      const callArgs = mockedCreateFnAgent.mock.calls[0]![0];
      const toolNames = callArgs.customTools!.map((t: any) => t.name);
      // fn_heartbeat_done should be last for stable terminal signaling
      expect(toolNames[toolNames.length - 1]).toBe("fn_heartbeat_done");
    });

    it("calls promptWithFallback with task context", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "assignment", triggerDetail: "new task assigned" });

      expect(mockSession.prompt).toHaveBeenCalledOnce();
      const promptArg = mockSession.prompt.mock.calls[0]![0] as string;
      expect(promptArg).toContain("agent-001");
      expect(promptArg).toContain("Test Task");
      expect(promptArg).toContain("assignment");
      expect(promptArg).toContain("new task assigned");
      expect(promptArg).toContain("PROMPT.md");
    });

    it("includes triggering comment context in execution prompt when comment IDs are provided", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      mockTaskStore.getTask = vi.fn().mockResolvedValue({
        id: "FN-001",
        title: "Test Task",
        description: "Test task description",
        prompt: "# Prompt",
        comments: [{ id: "c-1", author: "user", text: "Please cover edge cases", createdAt: "2026-01-01T00:00:00.000Z" }],
        steeringComments: [{ id: "s-1", author: "agent", text: "Investigating blocker", createdAt: "2026-01-01T00:01:00.000Z" }],
        steps: [],
        column: "todo",
        dependencies: [],
        log: [],
        attachments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as TaskDetail);

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "on_demand",
        triggeringCommentIds: ["c-1", "s-1"],
        triggeringCommentType: "steering",
      });

      const promptArg = mockSession.prompt.mock.calls[0]![0] as string;
      expect(promptArg).toContain("You were woken because of new comments on this task");
      expect(promptArg).toContain("Please cover edge cases");
      expect(promptArg).toContain("Investigating blocker");
    });

    it("keeps standard prompt when no triggering comments are provided", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      const promptArg = mockSession.prompt.mock.calls[0]![0] as string;
      expect(promptArg).not.toContain("You were woken because of new comments on this task");
      expect(promptArg).not.toContain("New comments since last run:");
    });

    it("completes run with status completed on successful execution", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result).toBeDefined();
      expect(result.status).toBe("completed");
      // Agent state should be set back to active
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
      // Session should be disposed
      expect(mockSession.dispose).toHaveBeenCalled();
    });

    it("uses explicit taskId override instead of agent.taskId", async () => {
      const store = createStoreWithAgentForExec({ taskId: "FN-DEFAULT" });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      // Override getTask to return a different task
      mockTaskStore.getTask = vi.fn().mockResolvedValue({
        id: "FN-OVERRIDE",
        title: "Override Task",
        description: "Override description",
        prompt: "",
        steps: [],
        column: "todo",
        dependencies: [],
        log: [],
        attachments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as TaskDetail);

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "on_demand",
        taskId: "FN-OVERRIDE",
      });

      // Should have fetched the override task
      expect(mockTaskStore.getTask).toHaveBeenCalledWith("FN-OVERRIDE");
      // fn_task_log tool should use the override task ID
      const callArgs = mockedCreateFnAgent.mock.calls[0]![0];
      const taskLogTool = callArgs.customTools![1]!;
      expect(taskLogTool.name).toBe("fn_task_log");
    });

    it("uses complete assigned runtime model ahead of shared execution settings", async () => {
      const store = createStoreWithAgentForExec({
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5" },
      });
      mockTaskStore = createMockTaskStore({
        getSettings: vi.fn().mockResolvedValue({
          executionProvider: "openai",
          executionModelId: "gpt-4.1",
        }),
      });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
      const callArgs = mockedCreateFnAgent.mock.calls[0]![0];
      expect(callArgs.defaultProvider).toBe("anthropic");
      expect(callArgs.defaultModelId).toBe("claude-sonnet-4-5");
      expect(callArgs.fallbackProvider).toBeUndefined();
      expect(callArgs.fallbackModelId).toBeUndefined();
    });

    it("passes undefined model when runtimeConfig has no model", async () => {
      const store = createStoreWithAgentForExec({ runtimeConfig: {} });
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      const callArgs = mockedCreateFnAgent.mock.calls[0]![0];
      expect(callArgs.defaultProvider).toBeUndefined();
      expect(callArgs.defaultModelId).toBeUndefined();
    });

    it("persists contextSnapshot on run records", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "assignment",
        triggerDetail: "task-assigned",
        triggeringCommentIds: ["comment-1"],
        triggeringCommentType: "task",
        contextSnapshot: {
          wakeReason: "assignment",
          triggerDetail: "task-assigned",
          taskId: "FN-001",
        },
      });

      expect(result.contextSnapshot).toEqual({
        wakeReason: "assignment",
        triggerDetail: "task-assigned",
        taskId: "FN-001",
        triggeringCommentIds: ["comment-1"],
        triggeringCommentType: "task",
        heartbeatScopeDiscipline: "strict",
        heartbeatPromptTemplate: "default",
      });
    });

    it("persists automation source recovery context on run records", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({
        agentId: "agent-001",
        source: "automation",
        triggerDetail: "self-healing durable-agent transient recovery",
        contextSnapshot: {
          selfHealing: {
            reason: "transient-error",
            attempt: 1,
            source: "durable-agent-transient-error-recovery",
          },
        },
      });

      expect(result.contextSnapshot).toEqual(
        expect.objectContaining({
          selfHealing: {
            reason: "transient-error",
            attempt: 1,
            source: "durable-agent-transient-error-recovery",
          },
        }),
      );
    });

    it("records agent logs, context taskId, and stdoutExcerpt for successful runs", async () => {
      const store = createStoreWithAgentForExec();
      const appendAgentLog = vi.fn().mockResolvedValue(undefined);
      mockTaskStore = createMockTaskStore({ appendAgentLog });

      const mockSession = createMockAgentSession();
      let onText: ((delta: string) => void) | undefined;
      let onToolStart: ((name: string, args?: Record<string, unknown>) => void) | undefined;
      let onToolEnd: ((name: string, isError: boolean, result?: unknown) => void) | undefined;

      mockedCreateFnAgent.mockImplementation(async (opts: any) => {
        onText = opts.onText;
        onToolStart = opts.onToolStart;
        onToolEnd = opts.onToolEnd;
        return { session: mockSession as any };
      });

      mockSession.prompt = vi.fn().mockImplementation(async () => {
        onText?.("Heartbeat produced visible output");
        onToolStart?.("read", { path: "README.md" });
        onToolEnd?.("read", false, "done");
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      // FN-7503 added an optional 6th timing arg; pin the first five and tolerate timing.
      expectAppendAgentLog(appendAgentLog, "FN-001", "Heartbeat produced visible output", "text", undefined, "executor");
      expectAppendAgentLog(appendAgentLog, "FN-001", "read", "tool", undefined, "executor");
      expectAppendAgentLog(appendAgentLog, "FN-001", "read", "tool_result", undefined, "executor");
      expect(result.contextSnapshot?.taskId).toBe("FN-001");
      expect(result.stdoutExcerpt).toContain("Heartbeat produced visible output");
    });
  });

  describe("fn_heartbeat_done tool", () => {
    it("captures summary from fn_heartbeat_done in resultJson", async () => {
      const store = createStoreWithAgentForExec();
      let capturedDoneTool: any;
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockImplementation(async (opts: any) => {
        // fn_heartbeat_done is last in the customTools array (index 4)
        capturedDoneTool = opts.customTools[opts.customTools.length - 1];
        return { session: mockSession as any };
      });

      // Simulate: when prompt is called, invoke the fn_heartbeat_done tool
      mockSession.prompt = vi.fn().mockImplementation(async (prompt: string) => {
        // Simulate the agent calling fn_heartbeat_done
        const result = await capturedDoneTool.execute("call-1", { summary: "Checked task, all good" });
        expect(result.content[0].text).toContain("Heartbeat complete");
        expect(result.content[0].text).toContain("Checked task, all good");
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const run = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(run.resultJson).toBeDefined();
      expect((run.resultJson as any).summary).toBe("Checked task, all good");
    });

    it("works without summary in fn_heartbeat_done", async () => {
      const store = createStoreWithAgentForExec();
      let capturedDoneTool: any;
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockImplementation(async (opts: any) => {
        capturedDoneTool = opts.customTools[opts.customTools.length - 1];
        return { session: mockSession as any };
      });

      mockSession.prompt = vi.fn().mockImplementation(async () => {
        await capturedDoneTool.execute("call-1", {});
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const run = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(run.resultJson).toBeDefined();
      expect((run.resultJson as any).summary).toBeUndefined();
    });
  });

  describe("fn_task_create tool", () => {
    it("creates a task in the store when fn_task_create tool is called", async () => {
      const store = createStoreWithAgentForExec();
      let capturedCreateTool: any;
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockImplementation(async (opts: any) => {
        capturedCreateTool = opts.customTools[0]; // fn_task_create
        return { session: mockSession as any };
      });

      mockSession.prompt = vi.fn().mockImplementation(async () => {
        await capturedCreateTool.execute("call-1", { description: "Follow-up task" });
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      // FN-7536+: createTask input no longer carries `column` (defaulted server-side to triage) and now forwards `githubTracking`; objectContaining tolerates the extra key.
      // FNXC:TaskCreateDedup 2026-07-18-14:45: second arg also carries onProposalClaimConflict after FN-8277; match loosely.
      expect(mockTaskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
        description: "Follow-up task",
        dependencies: undefined,
        priority: undefined,
        summarize: true,
        source: expect.objectContaining({
          sourceType: "agent_heartbeat",
          sourceAgentId: "agent-001",
          sourceRunId: "run-001",
          sourceParentTaskId: "FN-001",
          sourceMetadata: expect.objectContaining({
            contentFingerprint: expect.any(String),
          }),
        }),
      }), expect.objectContaining({ settings: {} }));
    });

    it("forwards explicit priority when fn_task_create tool is called", async () => {
      const store = createStoreWithAgentForExec();
      let capturedCreateTool: any;
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockImplementation(async (opts: any) => {
        capturedCreateTool = opts.customTools[0];
        return { session: mockSession as any };
      });

      mockSession.prompt = vi.fn().mockImplementation(async () => {
        await capturedCreateTool.execute("call-1", { description: "Follow-up task", priority: "high" });
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(mockTaskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
        priority: "high",
      }), expect.any(Object));
    });
  });

  describe("error handling", () => {
    it("completes run as failed when createFnAgent throws", async () => {
      const store = createStoreWithAgentForExec();
      mockedCreateFnAgent.mockRejectedValue(new Error("Model unavailable"));

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result).toBeDefined();
      expect(result.status).toBe("failed");
      expect(result.stderrExcerpt).toContain("Model unavailable");
      // FNXC:HeartbeatTests 2026-07-12-16:10: FN-7878 treats generic session startup failures such as "Model unavailable" as recoverable unless an operator-actionable auth/model/billing signal is present.
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "error");
      expect(store.updateAgentState).not.toHaveBeenCalledWith("agent-001", "paused");
    });

    it("fails soft on timer heartbeat when model provider credentials are unavailable", async () => {
      const store = createStoreWithAgentForExec();
      mockedCreateFnAgent.mockRejectedValue(new Error("No API key for provider: anthropic"));

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result.status).toBe("completed");
      expect(result.resultJson).toMatchObject({
        reason: "heartbeat_model_unavailable",
        source: "timer",
        detail: expect.stringContaining("No API key for provider: anthropic"),
      });
      expect(result.stderrExcerpt).toContain("No API key for provider: anthropic");
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
      expect(store.updateAgentState).not.toHaveBeenCalledWith("agent-001", "error");
    });

    it.each(["on_demand", "assignment"] as const)("pauses on %s heartbeat when model provider credentials are unavailable", async (source) => {
      const store = createStoreWithAgentForExec();
      mockedCreateFnAgent.mockRejectedValue(new Error("No API key for provider: anthropic"));

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source });

      expect(result.status).toBe("completed");
      expect(result.resultJson).toMatchObject({
        reason: "heartbeat_model_unavailable",
        source,
        actionRequired: true,
        detail: expect.stringContaining("Configure credentials for provider \"anthropic\""),
      });
      expect(result.stderrExcerpt).toContain("No API key for provider: anthropic");
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "paused");
      expect(store.updateAgent).toHaveBeenCalledWith("agent-001", {
        pauseReason: "heartbeat-model-unavailable",
        lastError: expect.stringContaining("No API key for provider: anthropic"),
      });
      expect(store.updateAgentState).not.toHaveBeenCalledWith("agent-001", "error");
    });

    it("keeps timer-triggered credential failures in recoverable state across consecutive wakeups", async () => {
      const store = createStoreWithAgentForExec();
      mockedCreateFnAgent.mockRejectedValue(new Error("No API key for provider: anthropic"));

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const first = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });
      const second = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      for (const run of [first, second]) {
        expect(run.status).toBe("completed");
        expect(run.resultJson).toMatchObject({
          reason: "heartbeat_model_unavailable",
          source: "timer",
          detail: expect.stringContaining("No API key for provider: anthropic"),
        });
        expect(run.stderrExcerpt).toContain("No API key for provider: anthropic");
      }

      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
      expect(store.updateAgentState).not.toHaveBeenCalledWith("agent-001", "error");
    });

    it("keeps non-timer credential failures recoverable on consecutive wakeups", async () => {
      const store = createStoreWithAgentForExec();
      mockedCreateFnAgent.mockRejectedValue(new Error("No API key for provider: anthropic"));

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const first = await monitor.executeHeartbeat({ agentId: "agent-001", source: "assignment" });
      const second = await monitor.executeHeartbeat({ agentId: "agent-001", source: "assignment" });

      expect(first.status).toBe("completed");
      expect(first.resultJson).toMatchObject({
        reason: "heartbeat_model_unavailable",
        source: "assignment",
        actionRequired: true,
      });
      expect(second.status).toBe("completed");
      expect(second.resultJson).toMatchObject({
        reason: "heartbeat_model_unavailable",
        source: "assignment",
        actionRequired: true,
      });
      expect(store.updateAgentState).not.toHaveBeenCalledWith("agent-001", "error");
    });

    it("completes run as failed when promptWithFallback throws", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });
      mockSession.prompt = vi.fn().mockRejectedValue(new Error("Prompt failed"));

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result).toBeDefined();
      expect(result.status).toBe("failed");
      expect(result.stderrExcerpt).toContain("Prompt failed");
      // Session should still be disposed in finally block
      expect(mockSession.dispose).toHaveBeenCalled();
      // Agent should be untracked
      expect(monitor.getTrackedAgents()).not.toContain("agent-001");
    });

    it("flushes AgentLogger on execution failure", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      const flushSpy = vi.spyOn(AgentLogger.prototype, "flush").mockResolvedValue(undefined);

      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });
      mockSession.prompt = vi.fn().mockRejectedValue(new Error("Prompt failed"));

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(flushSpy).toHaveBeenCalled();
    });

    it("flushes AgentLogger when session creation fails", async () => {
      const store = createStoreWithAgentForExec();
      const flushSpy = vi.spyOn(AgentLogger.prototype, "flush").mockResolvedValue(undefined);
      mockedCreateFnAgent.mockRejectedValue(new Error("Model unavailable"));

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(flushSpy).toHaveBeenCalled();
    });
  });

  describe("concurrency", () => {
    it("serializes concurrent executeHeartbeat calls for the same agent", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      let promptCallCount = 0;

      // Make prompt take some time to ensure overlap
      mockSession.prompt = vi.fn().mockImplementation(async () => {
        promptCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      // We need getRunDetail to return different runs for each call
      let runCount = 0;
      const concurrentSavedRuns: Map<string, AgentHeartbeatRun> = new Map();
      (store.startHeartbeatRun as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        runCount++;
        return {
          id: `run-${runCount}`,
          agentId: "agent-001",
          startedAt: new Date().toISOString(),
          endedAt: null,
          status: "active",
        } as AgentHeartbeatRun;
      });
      (store.saveRun as ReturnType<typeof vi.fn>).mockImplementation(async (run: AgentHeartbeatRun) => {
        concurrentSavedRuns.set(run.id, run);
      });
      (store.getRunDetail as ReturnType<typeof vi.fn>).mockImplementation(async (_agentId: string, runId: string) => {
        return concurrentSavedRuns.get(runId) ?? {
          id: runId,
          agentId: "agent-001",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          status: "completed" as const,
        };
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      // Fire two concurrent executions
      const [result1, result2] = await Promise.all([
        monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" }),
        monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" }),
      ]);

      // Both should complete
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      // Both should have called prompt (serialized, not concurrent)
      expect(promptCallCount).toBe(2);
    });
  });

  describe("usage tracking", () => {
    it("records estimated output tokens in usageJson", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      let onTextCallback: ((delta: string) => void) | undefined;

      mockedCreateFnAgent.mockImplementation(async (opts: any) => {
        onTextCallback = opts.onText;
        return { session: mockSession as any };
      });

      // Simulate text output
      mockSession.prompt = vi.fn().mockImplementation(async () => {
        // Simulate 100 chars of output (roughly 25 tokens at 4 chars/token)
        if (onTextCallback) {
          onTextCallback("A".repeat(100));
        }
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result.usageJson).toBeDefined();
      expect(result.usageJson!.inputTokens).toBe(0);
      expect(result.usageJson!.outputTokens).toBe(25); // 100/4 = 25
      expect(result.usageJson!.cachedTokens).toBe(0);
    });

    it("accumulates usage on agent record", async () => {
      const store = createStoreWithAgentForExec({
        totalInputTokens: 100,
        totalOutputTokens: 200,
      });
      const mockSession = createMockAgentSession();
      let onTextCallback: ((delta: string) => void) | undefined;

      mockedCreateFnAgent.mockImplementation(async (opts: any) => {
        onTextCallback = opts.onText;
        return { session: mockSession as any };
      });

      mockSession.prompt = vi.fn().mockImplementation(async () => {
        if (onTextCallback) {
          onTextCallback("A".repeat(100));
        }
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      // Should update cumulative tokens: 200 + 25 = 225
      expect(store.updateAgent).toHaveBeenCalledWith("agent-001", {
        totalInputTokens: 100,
        totalOutputTokens: 225,
      });
    });
  });

  describe("cleanup", () => {
    it("disposes session and untracks agent even on error", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });
      mockSession.prompt = vi.fn().mockRejectedValue(new Error("Crash"));

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      // Session disposed
      expect(mockSession.dispose).toHaveBeenCalled();
      // Agent untracked
      expect(monitor.getTrackedAgents()).not.toContain("agent-001");
    });

    it("disposes session and untracks agent on success", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({
        session: mockSession as any,
      });

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(mockSession.dispose).toHaveBeenCalled();
      expect(monitor.getTrackedAgents()).not.toContain("agent-001");
    });
  });

  describe("Budget Governance", () => {
    it("skips heartbeat when agent is over budget (timer)", async () => {
      const budgetStatus = createBudgetStatus({
        currentUsage: 10000,
        budgetLimit: 10000,
        usagePercent: 100,
        thresholdPercent: 80,
        isOverBudget: true,
        isOverThreshold: true,
      });
      const store = createStoreWithAgentForExec();
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(budgetStatus);

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result.status).toBe("completed");
      expect(result.resultJson).toMatchObject({ reason: "budget_exhausted", budgetStatus });
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
      expect(store.updateAgentState).not.toHaveBeenCalledWith("agent-001", "active");
    });

    it("skips heartbeat when agent is over budget (on_demand)", async () => {
      const store = createStoreWithAgentForExec();
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        createBudgetStatus({ isOverBudget: true, isOverThreshold: true, usagePercent: 100 })
      );

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result.resultJson).toMatchObject({ reason: "budget_exhausted" });
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    });

    it("skips heartbeat when agent is over budget (assignment)", async () => {
      const store = createStoreWithAgentForExec();
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        createBudgetStatus({ isOverBudget: true, isOverThreshold: true, usagePercent: 100 })
      );

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "assignment" });

      expect(result.resultJson).toMatchObject({ reason: "budget_exhausted" });
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    });

    it("skips timer heartbeat when agent is over threshold but not over budget", async () => {
      const budgetStatus = createBudgetStatus({
        currentUsage: 850,
        budgetLimit: 1000,
        usagePercent: 85,
        thresholdPercent: 80,
        isOverBudget: false,
        isOverThreshold: true,
      });
      const store = createStoreWithAgentForExec();
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(budgetStatus);

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result.resultJson).toMatchObject({ reason: "budget_threshold_exceeded", budgetStatus });
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    });

    it("allows on_demand heartbeat when agent is over threshold", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        createBudgetStatus({ isOverThreshold: true, usagePercent: 85, budgetLimit: 1000, thresholdPercent: 80 })
      );

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result.status).toBe("completed");
      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
    });

    it("allows assignment heartbeat when agent is over threshold", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        createBudgetStatus({ isOverThreshold: true, usagePercent: 85, budgetLimit: 1000, thresholdPercent: 80 })
      );

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "assignment" });

      expect(result.status).toBe("completed");
      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
    });

    it("proceeds normally when agent is below threshold", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        createBudgetStatus({ isOverBudget: false, isOverThreshold: false, usagePercent: 30, budgetLimit: 1000, thresholdPercent: 80 })
      );

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result.status).toBe("completed");
      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
    });

    it("proceeds normally when getBudgetStatus throws", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("budget unavailable"));

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result.status).toBe("completed");
      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
    });
  });

  describe("Pause Governance", () => {
    it("skips heartbeat on global pause for timer source", async () => {
      const store = createStoreWithAgentForExec();
      const pauseAwareTaskStore = createMockTaskStore({
        getSettings: vi.fn().mockResolvedValue({ globalPause: true, enginePaused: false }),
      });
      const monitor = new HeartbeatMonitor({ store, taskStore: pauseAwareTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(result.status).toBe("completed");
      expect(result.resultJson).toMatchObject({ reason: "global_pause", source: "timer" });
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    });

    it("skips heartbeat on global pause for assignment source", async () => {
      const store = createStoreWithAgentForExec();
      const pauseAwareTaskStore = createMockTaskStore({
        getSettings: vi.fn().mockResolvedValue({ globalPause: true, enginePaused: false }),
      });
      const monitor = new HeartbeatMonitor({ store, taskStore: pauseAwareTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "assignment" });

      expect(result.status).toBe("completed");
      expect(result.resultJson).toMatchObject({ reason: "global_pause", source: "assignment" });
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    });

    it("skips timer heartbeat on engine pause but allows assignment", async () => {
      const timerStore = createStoreWithAgentForExec();
      const pauseAwareTaskStore = createMockTaskStore({
        getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: true }),
      });
      const timerMonitor = new HeartbeatMonitor({ store: timerStore, taskStore: pauseAwareTaskStore, rootDir: "/tmp" });

      const timerResult = await timerMonitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

      expect(timerResult.status).toBe("completed");
      expect(timerResult.resultJson).toMatchObject({ reason: "engine_paused", source: "timer" });
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();

      const assignmentStore = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      const assignmentMonitor = new HeartbeatMonitor({
        store: assignmentStore,
        taskStore: pauseAwareTaskStore,
        rootDir: "/tmp",
      });

      const assignmentResult = await assignmentMonitor.executeHeartbeat({
        agentId: "agent-001",
        source: "assignment",
      });

      expect(assignmentResult.status).toBe("completed");
      expect((assignmentResult.resultJson as Record<string, unknown>)?.reason).not.toBe("engine_paused");
      expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
    });

    it("proceeds when pause flags are false", async () => {
      const store = createStoreWithAgentForExec();
      const mockSession = createMockAgentSession();
      mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });
      const pauseAwareTaskStore = createMockTaskStore({
        getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
      });
      const monitor = new HeartbeatMonitor({ store, taskStore: pauseAwareTaskStore, rootDir: "/tmp" });

      const timerResult = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });
      const onDemandResult = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });
      const assignmentResult = await monitor.executeHeartbeat({ agentId: "agent-001", source: "assignment" });

      expect(timerResult.status).toBe("completed");
      expect(onDemandResult.status).toBe("completed");
      expect(assignmentResult.status).toBe("completed");
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(3);
    });
  });
});

// ── Task Creation Tracking Tests ──────────────────────────────────────
