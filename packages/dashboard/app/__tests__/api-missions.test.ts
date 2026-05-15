import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchTaskDetail,
  uploadAttachment,
  fetchAgentLogsWithMeta,
  fetchAiSessions,
  fetchAiSession,
  fetchMissionInterviewDrafts,
  discardMissionInterviewDraft,
  deleteAiSession,
  updateTask,
  createTask,
  connectPlanningStream,
  connectSubtaskStream,
  connectMissionInterviewStream,
  assignTask,
  fetchAgentTasks,
  archiveTask,
  unarchiveTask,
  deleteTask,
  ApiRequestError,
  moveTask,
  mergeTask,
  retryTask,
  duplicateTask,
  pauseTask,
  unpauseTask,
  fetchAuthStatus,
  loginProvider,
  logoutProvider,
  fetchModels,
  addSteeringComment,
  addTaskComment,
  updateTaskComment,
  deleteTaskComment,
  fetchTaskComments,
  fetchGitRemotes,
  refineTask,
  fetchBatchStatus,
  fetchWorkspaces,
  fetchWorkspaceFileList,
  fetchWorkspaceFileContent,
  saveWorkspaceFileContent,
  deleteFile,
  startPlanningStreaming,
  startAgentOnboardingStreaming,
  respondToAgentOnboarding,
  retryAgentOnboardingSession,
  stopAgentOnboardingGeneration,
  cancelAgentOnboarding,
  fetchTasks,
  summarizeTitle,
  fetchProjects,
  registerProject,
  unregisterProject,
  fetchProjectHealth,
  fetchActivityFeed,
  pauseProject,
  resumeProject,
  fetchFirstRunStatus,
  fetchGlobalConcurrency,
  updateGlobalConcurrency,
  fetchPiSettings,
  updatePiSettings,
  installPiPackage,
  reinstallFusionPiPackage,
  fetchPiExtensions,
  updatePiExtensions,
  fetchProjectTasks,
  fetchProjectConfig,
  fetchExecutorStats,
  fetchAgentRunAudit,
  fetchAgentRunTimeline,
  streamChatResponse,
  fetchMemoryBackendStatus,
  type ProjectInfo,
  type ProjectHealth,
  type ActivityFeedEntry,
  type FirstRunStatus,
  type GlobalConcurrencyState,
  type ExecutorStats,
  type ExecutorState,
} from "../api";
import type { Task, TaskDetail, BatchStatusResponse, MergeResult } from "@fusion/core";
import { clearAuthToken } from "../auth";

const TASK_TOKEN_USAGE_FIXTURE = {
  inputTokens: 1000,
  outputTokens: 300,
  cachedTokens: 125,
  totalTokens: 1425,
  firstUsedAt: "2026-04-24T08:00:00.000Z",
  lastUsedAt: "2026-04-24T09:30:00.000Z",
};

const FAKE_DETAIL: TaskDetail = {
  id: "FN-001",
  description: "Test",
  column: "in-progress",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  tokenUsage: TASK_TOKEN_USAGE_FIXTURE,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# FN-001",
};

function mockFetchResponse(
  ok: boolean,
  body: unknown,
  status = ok ? 200 : 500,
  contentType = "application/json"
) {
  const bodyText = JSON.stringify(body);
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyText),
  } as unknown as Response);
}

beforeEach(() => {
  clearAuthToken();
  localStorage.removeItem("fn.authToken");
});

afterEach(() => {
  clearAuthToken();
  localStorage.removeItem("fn.authToken");
});


import {
  fetchGitRemotesDetailed,
  addGitRemote,
  removeGitRemote,
  renameGitRemote,
  updateGitRemoteUrl,
} from "../api";


import { approvePlan, rejectPlan } from "../api";

import {
  startAgentRun,
  createAgent,
  updateAgent,
  fetchGitStatus,
  fetchGitCommits,
  fetchCommitDiff,
  fetchAheadCommits,
  fetchRemoteCommits,
  fetchGitBranches,
  fetchGitWorktrees,
  createBranch,
  checkoutBranch,
  deleteBranch,
  fetchRemote,
  pullBranch,
  pushBranch,
} from "../api";


import { startPlanning, respondToPlanning, cancelPlanning, createTaskFromPlanning } from "../api";
import type { PlanningQuestion, PlanningSummary } from "@fusion/core";


import { refineText, getRefineErrorMessage, REFINE_ERROR_MESSAGES, type RefinementType } from "../api";


function mockHtmlErrorResponse(status: number, htmlBody: string) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: "Not Found",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "text/html" : null,
    },
    json: () => Promise.reject(new Error("JSON parse error")),
    text: () => Promise.resolve(htmlBody),
  } as unknown as Response);
}

const FAKE_PROJECT: ProjectInfo = {
  id: "proj_abc123",
  name: "Test Project",
  path: "/path/to/project",
  status: "active",
  isolationMode: "in-process",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
};

const FAKE_PROJECT_HEALTH: ProjectHealth = {
  projectId: "proj_abc123",
  status: "active",
  activeTaskCount: 5,
  inFlightAgentCount: 2,
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  totalTasksCompleted: 100,
  totalTasksFailed: 5,
  averageTaskDurationMs: 600000,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const FAKE_ACTIVITY_ENTRY: ActivityFeedEntry = {
  id: "act_123",
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "task:created",
  projectId: "proj_abc123",
  projectName: "Test Project",
  taskId: "KB-001",
  taskTitle: "Test Task",
  details: "Task created",
};


describe("Mission mutation coverage with 204 responses", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns undefined for void responses (204 No Content)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { deleteMission } = await import("../api");
    const result = await deleteMission("M-LZ7DN0-A2B5");
    expect(result).toBeUndefined();
  });

  it("returns undefined for milestone delete (204 No Content)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { deleteMilestone } = await import("../api");
    const result = await deleteMilestone("MS-M3N8QR-C9F1");
    expect(result).toBeUndefined();
  });

  it("returns undefined for slice delete (204 No Content)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { deleteSlice } = await import("../api");
    const result = await deleteSlice("SL-P4T2WX-D5E8");
    expect(result).toBeUndefined();
  });

  it("returns undefined for feature delete (204 No Content)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { deleteFeature } = await import("../api");
    const result = await deleteFeature("F-J6K9AB-G7H3");
    expect(result).toBeUndefined();
  });

  it("returns undefined for milestone reorder (204 No Content)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { reorderMilestones } = await import("../api");
    const result = await reorderMilestones("M-LZ7DN0-A2B5", ["MS-1", "MS-2"]);
    expect(result).toBeUndefined();
  });

  it("returns undefined for slice reorder (204 No Content)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { reorderSlices } = await import("../api");
    const result = await reorderSlices("MS-M3N8QR-C9F1", ["SL-1", "SL-2"]);
    expect(result).toBeUndefined();
  });

  it("handles 204 with projectId query param", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { deleteMission } = await import("../api");
    const result = await deleteMission("M-LZ7DN0-A2B5", "my-project");
    expect(result).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/missions/M-LZ7DN0-A2B5?projectId=my-project"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("still throws on JSON error responses (non-204)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Mission not found" }, 404)
    );

    const { deleteMission } = await import("../api");
    await expect(deleteMission("M-999")).rejects.toThrow("Mission not found");
  });

  it("still throws on invalid ID format (400)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Invalid mission ID format" }, 400)
    );

    const { deleteMission } = await import("../api");
    await expect(deleteMission("bad-id")).rejects.toThrow("Invalid mission ID format");
  });
});

describe("resilient SSE reconnect", () => {
  const OriginalEventSource = globalThis.EventSource;
  const originalFetch = globalThis.fetch;

  class ControlledEventSource {
    static instances: ControlledEventSource[] = [];
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    readyState = ControlledEventSource.OPEN;
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

    constructor(public readonly url: string) {
      ControlledEventSource.instances.push(this);
    }

    addEventListener(eventName: string, listener: (event: MessageEvent) => void): void {
      if (!this.listeners.has(eventName)) {
        this.listeners.set(eventName, new Set());
      }
      this.listeners.get(eventName)!.add(listener);
    }

    removeEventListener(eventName: string, listener: (event: MessageEvent) => void): void {
      this.listeners.get(eventName)?.delete(listener);
    }

    close(): void {
      this.readyState = ControlledEventSource.CLOSED;
    }

    emitOpen(): void {
      this.readyState = ControlledEventSource.OPEN;
      this.onopen?.(new Event("open"));
    }

    emitConnectionError(state: number): void {
      this.readyState = state;
      this.onerror?.(new Event("error"));
    }

    emitEvent(eventName: string, data: string, lastEventId = ""): void {
      const event = { data, lastEventId } as MessageEvent;
      for (const listener of this.listeners.get(eventName) ?? []) {
        listener(event);
      }
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    ControlledEventSource.instances = [];
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: ControlledEventSource,
    });
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ok: true }));
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: OriginalEventSource,
    });
    globalThis.fetch = originalFetch;
  });

  it("reconnects with backoff and deduplicates replayed events", () => {
    const onThinking = vi.fn();
    const onState = vi.fn();

    connectPlanningStream("session-1", undefined, {
      onThinking,
      onConnectionStateChange: onState,
    });

    const firstConnection = ControlledEventSource.instances[0]!;
    firstConnection.emitOpen();
    firstConnection.emitEvent("thinking", JSON.stringify("first"), "1");

    firstConnection.emitConnectionError(ControlledEventSource.CLOSED);
    expect(onState).toHaveBeenCalledWith("reconnecting");

    vi.advanceTimersByTime(1000);

    const secondConnection = ControlledEventSource.instances[1]!;
    secondConnection.emitOpen();

    // Duplicate replayed event should be ignored by lastEventId tracking.
    secondConnection.emitEvent("thinking", JSON.stringify("first"), "1");
    secondConnection.emitEvent("thinking", JSON.stringify("second"), "2");

    expect(onThinking).toHaveBeenCalledTimes(2);
    expect(onThinking).toHaveBeenNthCalledWith(1, "first");
    expect(onThinking).toHaveBeenNthCalledWith(2, "second");
    expect(secondConnection.url).toContain("lastEventId=1");
  });

  it("stops reconnecting after max attempts and reports fatal error", () => {
    const onError = vi.fn();

    connectPlanningStream(
      "session-2",
      undefined,
      { onError },
      { maxReconnectAttempts: 2 },
    );

    const first = ControlledEventSource.instances[0]!;
    first.emitConnectionError(ControlledEventSource.CLOSED);
    vi.advanceTimersByTime(1000);

    const second = ControlledEventSource.instances[1]!;
    second.emitConnectionError(ControlledEventSource.CLOSED);
    vi.advanceTimersByTime(2000);

    const third = ControlledEventSource.instances[2]!;
    third.emitConnectionError(ControlledEventSource.CLOSED);

    expect(onError).toHaveBeenCalledWith("Connection lost");
  });

  it("manual close cancels pending reconnect", () => {
    const connection = connectPlanningStream("session-3", undefined, {});

    const first = ControlledEventSource.instances[0]!;
    first.emitConnectionError(ControlledEventSource.CLOSED);

    connection.close();
    vi.advanceTimersByTime(30_000);

    expect(ControlledEventSource.instances).toHaveLength(1);
  });

  it("starts planning keep-alive on open and stops on explicit close", () => {
    const connection = connectPlanningStream("session-keepalive", undefined, {});
    const stream = ControlledEventSource.instances[0]!;

    stream.emitOpen();
    vi.advanceTimersByTime(25_000);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai-sessions/session-keepalive/ping",
      expect.objectContaining({ method: "POST" }),
    );

    const pingCallsBeforeClose = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    connection.close();

    vi.advanceTimersByTime(50_000);

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(pingCallsBeforeClose);
    expect(stream.readyState).toBe(ControlledEventSource.CLOSED);
  });

  it("stops subtask keep-alive after complete event", () => {
    connectSubtaskStream("subtask-session", undefined, {});
    const stream = ControlledEventSource.instances[0]!;

    stream.emitOpen();
    vi.advanceTimersByTime(25_000);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai-sessions/subtask-session/ping",
      expect.objectContaining({ method: "POST" }),
    );

    const pingCallsBeforeComplete = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    stream.emitEvent("complete", "");

    vi.advanceTimersByTime(50_000);

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(pingCallsBeforeComplete);
    expect(stream.readyState).toBe(ControlledEventSource.CLOSED);
  });

  it("stops mission interview keep-alive after complete event", () => {
    connectMissionInterviewStream("mission-session", undefined, {});
    const stream = ControlledEventSource.instances[0]!;

    stream.emitOpen();
    vi.advanceTimersByTime(25_000);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai-sessions/mission-session/ping",
      expect.objectContaining({ method: "POST" }),
    );

    const pingCallsBeforeComplete = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    stream.emitEvent("complete", "");

    vi.advanceTimersByTime(50_000);

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(pingCallsBeforeComplete);
    expect(stream.readyState).toBe(ControlledEventSource.CLOSED);
  });

  it("silently ignores keep-alive ping failures", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const onThinking = vi.fn();
    const onError = vi.fn();

    connectPlanningStream("session-ping-failure", undefined, {
      onThinking,
      onError,
    });

    const stream = ControlledEventSource.instances[0]!;
    stream.emitOpen();

    vi.advanceTimersByTime(25_000);
    await Promise.resolve();

    stream.emitEvent("thinking", JSON.stringify("still-streaming"));

    expect(onThinking).toHaveBeenCalledWith("still-streaming");
    expect(onError).not.toHaveBeenCalled();
    expect(stream.readyState).toBe(ControlledEventSource.OPEN);
  });
});

describe("fetchAgentRunAudit", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("fetches run audit events with correct URL encoding", async () => {
    const mockResponse = {
      runId: "run-001",
      events: [],
      filters: {},
      totalCount: 0,
      hasMore: false,
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockResponse));

    const result = await fetchAgentRunAudit("agent-001", "run-001");

    expect(result).toEqual(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs/run-001/audit",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("passes projectId as query param", async () => {
    const mockResponse = { runId: "run-001", events: [], filters: {}, totalCount: 0, hasMore: false };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockResponse));

    await fetchAgentRunAudit("agent-001", "run-001", undefined, "my-project");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs/run-001/audit?projectId=my-project",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("includes filter params in query string", async () => {
    const mockResponse = { runId: "run-001", events: [], filters: {}, totalCount: 0, hasMore: false };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockResponse));

    await fetchAgentRunAudit("agent-001", "run-001", {
      domain: "git",
      taskId: "FN-001",
      limit: 50,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs/run-001/audit?taskId=FN-001&domain=git&limit=50",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("throws on 404 with 'Run not found' message", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Run not found" }, 404)
    );

    await expect(fetchAgentRunAudit("agent-001", "run-nonexistent")).rejects.toThrow("Run not found");
  });

  it("throws on 400 for blank runId before calling fetch", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { runId: "run-001", events: [], filters: {}, totalCount: 0, hasMore: false }));

    // Blank runId should throw synchronously before fetch is called
    expect(() => fetchAgentRunAudit("agent-001", "")).toThrow("runId is required");
    expect(() => fetchAgentRunAudit("agent-001", "   ")).toThrow("runId is required");
    // Note: URL-encoded values like "%20" are valid runId values (they're decoded at the URL level, not parameter level)

    // Verify fetch was never called for blank runId
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("fetchAgentRunTimeline", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("fetches run timeline with correct URL encoding", async () => {
    const mockResponse = {
      run: { id: "run-001", agentId: "agent-001", startedAt: "2026-01-01T00:00:00Z", status: "active" },
      auditByDomain: { database: [], git: [], filesystem: [], sandbox: [] },
      counts: { auditEvents: 0, logEntries: 0 },
      timeline: [],
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockResponse));

    const result = await fetchAgentRunTimeline("agent-001", "run-001");

    expect(result).toEqual(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs/run-001/timeline",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("passes projectId as query param", async () => {
    const mockResponse = {
      run: { id: "run-001", agentId: "agent-001", startedAt: "2026-01-01T00:00:00Z", status: "active" },
      auditByDomain: { database: [], git: [], filesystem: [], sandbox: [] },
      counts: { auditEvents: 0, logEntries: 0 },
      timeline: [],
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockResponse));

    await fetchAgentRunTimeline("agent-001", "run-001", undefined, "my-project");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs/run-001/timeline?projectId=my-project",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("includes options in query string", async () => {
    const mockResponse = {
      run: { id: "run-001", agentId: "agent-001", startedAt: "2026-01-01T00:00:00Z", status: "active" },
      auditByDomain: { database: [], git: [], filesystem: [], sandbox: [] },
      counts: { auditEvents: 0, logEntries: 0 },
      timeline: [],
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockResponse));

    await fetchAgentRunTimeline("agent-001", "run-001", {
      domain: "filesystem",
      taskId: "FN-001",
      includeLogs: false,
      limit: 100,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs/run-001/timeline?taskId=FN-001&domain=filesystem&includeLogs=false&limit=100",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("throws on 404 with 'Run not found' message", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Run not found" }, 404)
    );

    await expect(fetchAgentRunTimeline("agent-001", "run-nonexistent")).rejects.toThrow("Run not found");
  });

  it("throws on 400 for blank runId before calling fetch", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {
      run: { id: "run-001", agentId: "agent-001", startedAt: "2026-01-01T00:00:00Z", status: "active" },
      auditByDomain: { database: [], git: [], filesystem: [], sandbox: [] },
      counts: { auditEvents: 0, logEntries: 0 },
      timeline: [],
    }));

    // Blank runId should throw synchronously before fetch is called
    expect(() => fetchAgentRunTimeline("agent-001", "")).toThrow("runId is required");
    expect(() => fetchAgentRunTimeline("agent-001", "   ")).toThrow("runId is required");
    // Note: URL-encoded values like "%20" are valid runId values (they're decoded at the URL level, not parameter level)

    // Verify fetch was never called for blank runId
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("streamChatResponse", () => {
  const originalFetch = globalThis.fetch;

  const createStreamResponse = (chunks: string[]) => {
    const encoder = new TextEncoder();
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "text/event-stream" : null,
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      }),
      text: () => Promise.resolve(chunks.join("")),
    } as unknown as Response);
  };

  const withStreamResult = async (
    chunks: string[],
    assertCallbacks: (callbacks: {
      thinking: string[];
      text: string[];
      done: Array<{ messageId: string }>;
      error: string[];
      connectionStates: string[];
    }) => void,
  ) => {
    const callbacks = {
      thinking: [] as string[],
      text: [] as string[],
      done: [] as Array<{ messageId: string }>,
      error: [] as string[],
      connectionStates: [] as string[],
    };

    globalThis.fetch = vi.fn().mockImplementation(() => createStreamResponse(chunks));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for chat stream")), 10000);
      const stream = streamChatResponse("chat-1", "hello", {
        onThinking: (data) => callbacks.thinking.push(data),
        onText: (data) => callbacks.text.push(data),
        onDone: (data) => {
          callbacks.done.push(data);
          clearTimeout(timeout);
          stream.close();
          resolve();
        },
        onError: (data) => {
          callbacks.error.push(data);
          clearTimeout(timeout);
          stream.close();
          resolve();
        },
        onConnectionStateChange: (state) => callbacks.connectionStates.push(state),
      });
    });

    assertCallbacks(callbacks);
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends JSON content-type without Authorization when no token exists", async () => {
    await withStreamResult(
      [
        "event: done\ndata: {\"messageId\":\"msg-header\"}\n\n",
      ],
      () => {
        const call = vi.mocked(globalThis.fetch).mock.calls[0];
        const headers = call[1] ? new Headers((call[1] as RequestInit).headers) : new Headers();
        expect(headers.get("Content-Type")).toBe("application/json");
        expect(headers.get("Authorization")).toBeNull();
      },
    );
  });

  it("adds Authorization header for stream POST when daemon token exists", async () => {
    localStorage.setItem("fn.authToken", "daemon-token");

    await withStreamResult(
      [
        "event: done\ndata: {\"messageId\":\"msg-header\"}\n\n",
      ],
      () => {
        const call = vi.mocked(globalThis.fetch).mock.calls[0];
        const headers = call[1] ? new Headers((call[1] as RequestInit).headers) : new Headers();
        expect(headers.get("Content-Type")).toBe("application/json");
        expect(headers.get("Authorization")).toBe("Bearer daemon-token");
      },
    );
  });

  it("delivers chunk-split text and done events in order", async () => {
    await withStreamResult(
      [
        "event: te",
        "xt\ndata: \"Hel",
        "lo\"\n\nevent: do",
        "ne\ndata: {\"messageId\":\"msg-1\"}\n\n",
      ],
      (callbacks) => {
        expect(callbacks.connectionStates).toEqual(["connected"]);
        expect(callbacks.text).toEqual(["Hello"]);
        expect(callbacks.done).toEqual([{ messageId: "msg-1" }]);
        expect(callbacks.error).toEqual([]);
      },
    );
  });

  it("surfaces chunk-split error events through onError", async () => {
    await withStreamResult(
      [
        "event: err",
        "or\ndata: {\"message\":\"boom\"}\n\n",
      ],
      (callbacks) => {
        expect(callbacks.text).toEqual([]);
        expect(callbacks.done).toEqual([]);
        expect(callbacks.error).toEqual(["boom"]);
      },
    );
  });

  it("does not duplicate callbacks when multiple events arrive in one chunk", async () => {
    await withStreamResult(
      [
        "event: text\ndata: \"Hello\"\n\nevent: text\ndata: \" world\"\n\nevent: done\ndata: {\"messageId\":\"msg-2\"}\n\n",
      ],
      (callbacks) => {
        expect(callbacks.text).toEqual(["Hello", " world"]);
        expect(callbacks.done).toEqual([{ messageId: "msg-2" }]);
        expect(callbacks.text).toHaveLength(2);
        expect(callbacks.done).toHaveLength(1);
      },
    );
  });

  it("flushes a final complete event when the stream ends without a trailing blank line", async () => {
    await withStreamResult(
      [
        "event: text\ndata: \"tail\"\n\nevent: done\ndata: {\"messageId\":\"msg-tail\"}",
      ],
      (callbacks) => {
        expect(callbacks.text).toEqual(["tail"]);
        expect(callbacks.done).toEqual([{ messageId: "msg-tail" }]);
        expect(callbacks.error).toEqual([]);
      },
    );
  });

  it("flushes events built from partial chunks when stream ends without trailing newline", async () => {
    await withStreamResult(
      [
        "event: text\ndata: \"partial",
        " chunk\"\n\nevent: done\ndata: {\"messageId\":\"msg-x\"}",
      ],
      (callbacks) => {
        expect(callbacks.text).toEqual(["partial chunk"]);
        expect(callbacks.done).toEqual([{ messageId: "msg-x" }]);
        expect(callbacks.error).toEqual([]);
      },
    );
  });

  it("still delivers events normally when stream ends with proper newlines", async () => {
    await withStreamResult(
      [
        "event: text\ndata: \"hello\"\n\nevent: done\ndata: {\"messageId\":\"msg-n\"}\n\n",
      ],
      (callbacks) => {
        expect(callbacks.text).toEqual(["hello"]);
        expect(callbacks.done).toEqual([{ messageId: "msg-n" }]);
        expect(callbacks.error).toEqual([]);
      },
    );
  });

  it("does not dispatch when stream ends mid-event with incomplete data", async () => {
    const callbacks = {
      thinking: [] as string[],
      text: [] as string[],
      done: [] as Array<{ messageId: string }>,
      error: [] as string[],
      connectionStates: [] as string[],
    };

    globalThis.fetch = vi.fn().mockImplementation(() =>
      createStreamResponse([
        'event: text\ndata: "complete"\n\ndata: "incomp',
      ]),
    );

    const stream = streamChatResponse("chat-1", "hello", {
      onThinking: (data) => callbacks.thinking.push(data),
      onText: (data) => callbacks.text.push(data),
      onDone: (data) => callbacks.done.push(data),
      onError: (data) => callbacks.error.push(data),
      onConnectionStateChange: (state) => callbacks.connectionStates.push(state),
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    stream.close();

    expect(callbacks.text).toEqual(["complete"]);
    expect(callbacks.done).toEqual([]);
    expect(callbacks.error).toEqual([]);
  });

describe("mission interview draft api helpers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches mission interview drafts with project scope", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(true, {
        drafts: [{
          id: "session-1",
          title: "Draft mission",
          status: "awaiting_input",
          projectId: "project-a",
          createdAt: "2026-05-12T00:00:00.000Z",
          updatedAt: "2026-05-12T01:00:00.000Z",
          hasConversation: true,
        }],
      }),
    );

    const drafts = await fetchMissionInterviewDrafts("project-a");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/missions/interview/drafts?projectId=project-a",
      expect.objectContaining({ headers: expect.anything() }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.id).toBe("session-1");
  });

  it("discards a mission interview draft", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { removed: true }));

    const result = await discardMissionInterviewDraft("session-2", "project-a", "tab-1");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/missions/interview/drafts/session-2/discard?projectId=project-a",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ tabId: "tab-1" }),
      }),
    );
    expect(result).toEqual({ removed: true });
  });
});

  it("fires onError when fetch aborts unexpectedly", async () => {
    const callbacks = {
      error: [] as string[],
    };

    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));

    const stream = streamChatResponse("chat-1", "hello", {
      onError: (data) => callbacks.error.push(data),
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    stream.close();

    expect(callbacks.error).toEqual(["Connection aborted"]);
  });

  it("does not fire onError when abort is initiated by close", async () => {
    const callbacks = {
      error: [] as string[],
    };

    globalThis.fetch = vi.fn().mockImplementation((_, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          return;
        }
        const rejectAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
        if (signal.aborted) {
          rejectAbort();
          return;
        }
        signal.addEventListener("abort", rejectAbort, { once: true });
      });
    });

    const stream = streamChatResponse("chat-1", "hello", {
      onError: (data) => callbacks.error.push(data),
    });

    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(callbacks.error).toEqual([]);
  });
});

describe("fetchMemoryBackendStatus", () => {
  const originalFetch = globalThis.fetch;

  const mockBackendStatus = {
    currentBackend: "file",
    capabilities: {
      readable: true,
      writable: true,
      supportsAtomicWrite: true,
      hasConflictResolution: false,
      persistent: true,
    },
    availableBackends: ["file", "readonly", "qmd"],
  };

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches memory backend status without projectId", async () => {
    const { fetchMemoryBackendStatus } = await import("../api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockBackendStatus),
      text: () => Promise.resolve(JSON.stringify(mockBackendStatus)),
    } as unknown as Response);

    const result = await fetchMemoryBackendStatus();

    expect(result).toEqual(mockBackendStatus);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/memory/backend");
  });

  it("fetches memory backend status with projectId", async () => {
    const { fetchMemoryBackendStatus } = await import("../api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockBackendStatus),
      text: () => Promise.resolve(JSON.stringify(mockBackendStatus)),
    } as unknown as Response);

    const result = await fetchMemoryBackendStatus("proj_abc");

    expect(result).toEqual(mockBackendStatus);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/memory/backend");
    expect(call[0]).toContain("projectId=proj_abc");
  });

  it("throws on error response", async () => {
    const { fetchMemoryBackendStatus } = await import("../api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ error: "Server error" }),
      text: () => Promise.resolve(JSON.stringify({ error: "Server error" })),
    } as unknown as Response);

    await expect(fetchMemoryBackendStatus()).rejects.toThrow("Server error");
  });

  it("handles readonly backend response", async () => {
    const { fetchMemoryBackendStatus } = await import("../api");

    const readonlyStatus = {
      currentBackend: "readonly",
      capabilities: {
        readable: true,
        writable: false,
        supportsAtomicWrite: false,
        hasConflictResolution: false,
        persistent: false,
      },
      availableBackends: ["file", "readonly", "qmd"],
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(readonlyStatus),
      text: () => Promise.resolve(JSON.stringify(readonlyStatus)),
    } as unknown as Response);

    const result = await fetchMemoryBackendStatus();

    expect(result.currentBackend).toBe("readonly");
    expect(result.capabilities.writable).toBe(false);
  });

  it("handles qmd backend response", async () => {
    const { fetchMemoryBackendStatus } = await import("../api");

    const qmdStatus = {
      currentBackend: "qmd",
      capabilities: {
        readable: true,
        writable: true,
        supportsAtomicWrite: false,
        hasConflictResolution: false,
        persistent: true,
      },
      availableBackends: ["file", "readonly", "qmd"],
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(qmdStatus),
      text: () => Promise.resolve(JSON.stringify(qmdStatus)),
    } as unknown as Response);

    const result = await fetchMemoryBackendStatus();

    expect(result.currentBackend).toBe("qmd");
    expect(result.capabilities.writable).toBe(true);
    expect(result.capabilities.supportsAtomicWrite).toBe(false);
  });
});

describe("installQmd", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls POST /api/memory/install-qmd without projectId", async () => {
    const { installQmd } = await import("../api");
    const response = {
      success: true,
      qmdAvailable: true,
      qmdInstallCommand: "bun install -g @tobilu/qmd",
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(JSON.stringify(response)),
    } as unknown as Response);

    const result = await installQmd();

    expect(result).toEqual(response);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/memory/install-qmd");
    expect(call[1]).toMatchObject({ method: "POST" });
  });

  it("includes projectId when installing qmd for a project context", async () => {
    const { installQmd } = await import("../api");
    const response = {
      success: true,
      qmdAvailable: true,
      qmdInstallCommand: "bun install -g @tobilu/qmd",
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(JSON.stringify(response)),
    } as unknown as Response);

    await installQmd("proj_abc");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/memory/install-qmd");
    expect(call[0]).toContain("projectId=proj_abc");
  });
});

describe("compactMemory", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls POST /api/memory/compact without projectId", async () => {
    const { compactMemory } = await import("../api");

    const mockResponse = {
      path: ".fusion/memory/DREAMS.md",
      content: "# Compacted Memory\n\nImportant content here.",
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockResponse),
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    } as unknown as Response);

    const result = await compactMemory(".fusion/memory/DREAMS.md");

    expect(result).toEqual(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/memory/compact");
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBe(JSON.stringify({ path: ".fusion/memory/DREAMS.md" }));
  });

  it("calls POST /api/memory/compact with projectId", async () => {
    const { compactMemory } = await import("../api");

    const mockResponse = {
      path: ".fusion/memory/MEMORY.md",
      content: "# Compacted Memory\n\nImportant content here.",
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockResponse),
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    } as unknown as Response);

    const result = await compactMemory(".fusion/memory/MEMORY.md", "proj_abc");

    expect(result).toEqual(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/memory/compact");
    expect(call[0]).toContain("projectId=proj_abc");
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBe(JSON.stringify({ path: ".fusion/memory/MEMORY.md" }));
  });

  it("throws on error response", async () => {
    const { compactMemory } = await import("../api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ error: "AI service temporarily unavailable" }),
      text: () => Promise.resolve(JSON.stringify({ error: "AI service temporarily unavailable" })),
    } as unknown as Response);

    await expect(compactMemory(".fusion/memory/DREAMS.md")).rejects.toThrow("AI service temporarily unavailable");
  });
});

describe("fetchMemoryInsights", () => {
  it("calls GET /api/memory/insights without projectId", async () => {
    const { fetchMemoryInsights } = await import("../api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ content: "## Patterns\n- Pattern 1", exists: true }),
      text: () => Promise.resolve('{"content":"## Patterns\\n- Pattern 1","exists":true}'),
    } as unknown as Response);

    const result = await fetchMemoryInsights();

    expect(result).toEqual({ content: "## Patterns\n- Pattern 1", exists: true });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/insights");
    fetchSpy.mockRestore();
  });

  it("calls GET /api/memory/insights with projectId", async () => {
    const { fetchMemoryInsights } = await import("../api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ content: null, exists: false }),
      text: () => Promise.resolve('{"content":null,"exists":false}'),
    } as unknown as Response);

    const result = await fetchMemoryInsights("proj_abc");

    expect(result).toEqual({ content: null, exists: false });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/insights");
    expect(call[0]).toContain("projectId=proj_abc");
    fetchSpy.mockRestore();
  });
});

describe("saveMemoryInsights", () => {
  it("calls PUT /api/memory/insights without projectId", async () => {
    const { saveMemoryInsights } = await import("../api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ success: true }),
      text: () => Promise.resolve('{"success":true}'),
    } as unknown as Response);

    const result = await saveMemoryInsights("## Patterns\n- New insight");

    expect(result).toEqual({ success: true });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/insights");
    expect(call[1]!.method).toBe("PUT");
    expect(call[1]!.body).toBe(JSON.stringify({ content: "## Patterns\n- New insight" }));
    fetchSpy.mockRestore();
  });

  it("calls PUT /api/memory/insights with projectId", async () => {
    const { saveMemoryInsights } = await import("../api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ success: true }),
      text: () => Promise.resolve('{"success":true}'),
    } as unknown as Response);

    const result = await saveMemoryInsights("## Patterns\n- New insight", "proj_abc");

    expect(result).toEqual({ success: true });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/insights");
    expect(call[0]).toContain("projectId=proj_abc");
    expect(call[1]!.method).toBe("PUT");
    fetchSpy.mockRestore();
  });
});

describe("triggerInsightExtraction", () => {
  it("calls POST /api/memory/extract without projectId", async () => {
    const { triggerInsightExtraction } = await import("../api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ success: true, summary: "Extracted 3 insights", insightCount: 3, pruned: false }),
      text: () => Promise.resolve('{"success":true,"summary":"Extracted 3 insights","insightCount":3,"pruned":false}'),
    } as unknown as Response);

    const result = await triggerInsightExtraction();

    expect(result).toEqual({ success: true, summary: "Extracted 3 insights", insightCount: 3, pruned: false });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/extract");
    expect(call[1]!.method).toBe("POST");
    fetchSpy.mockRestore();
  });

  it("calls POST /api/memory/extract with projectId", async () => {
    const { triggerInsightExtraction } = await import("../api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ success: true, summary: "Extracted 5 insights", insightCount: 5, pruned: true }),
      text: () => Promise.resolve('{"success":true,"summary":"Extracted 5 insights","insightCount":5,"pruned":true}'),
    } as unknown as Response);

    const result = await triggerInsightExtraction("proj_abc");

    expect(result).toEqual({ success: true, summary: "Extracted 5 insights", insightCount: 5, pruned: true });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/extract");
    expect(call[0]).toContain("projectId=proj_abc");
    expect(call[1]!.method).toBe("POST");
    fetchSpy.mockRestore();
  });
});

describe("fetchMemoryAudit", () => {
  it("calls GET /api/memory/audit without projectId", async () => {
    const { fetchMemoryAudit } = await import("../api");
    const mockReport = {
      generatedAt: "2024-01-01T00:00:00.000Z",
      workingMemory: { exists: true, size: 100, sectionCount: 2 },
      insightsMemory: { exists: true, size: 50, insightCount: 5, categories: { pattern: 3 } },
      extraction: { runAt: "2024-01-01T00:00:00.000Z", success: true, insightCount: 5, duplicateCount: 0, skippedCount: 0, summary: "Extracted 5 insights" },
      pruning: { applied: false, reason: "No pruning needed", sizeDelta: 0, originalSize: 50, newSize: 50 },
      checks: [],
      health: "healthy" as const,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockReport),
      text: () => Promise.resolve(JSON.stringify(mockReport)),
    } as unknown as Response);

    const result = await fetchMemoryAudit();

    expect(result).toEqual(mockReport);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/audit");
    fetchSpy.mockRestore();
  });

  it("calls GET /api/memory/audit with projectId", async () => {
    const { fetchMemoryAudit } = await import("../api");
    const mockReport = {
      generatedAt: "2024-01-01T00:00:00.000Z",
      workingMemory: { exists: false, size: 0, sectionCount: 0 },
      insightsMemory: { exists: false, size: 0, insightCount: 0, categories: {} },
      extraction: { runAt: "", success: false, insightCount: 0, duplicateCount: 0, skippedCount: 0, summary: "" },
      pruning: { applied: false, reason: "", sizeDelta: 0, originalSize: 0, newSize: 0 },
      checks: [],
      health: "warning" as const,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockReport),
      text: () => Promise.resolve(JSON.stringify(mockReport)),
    } as unknown as Response);

    const result = await fetchMemoryAudit("proj_xyz");

    expect(result).toEqual(mockReport);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/audit");
    expect(call[0]).toContain("projectId=proj_xyz");
    fetchSpy.mockRestore();
  });
});

describe("fetchMemoryStats", () => {
  it("calls GET /api/memory/stats without projectId", async () => {
    const { fetchMemoryStats } = await import("../api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ workingMemorySize: 150, insightsSize: 50, insightsExists: true }),
      text: () => Promise.resolve('{"workingMemorySize":150,"insightsSize":50,"insightsExists":true}'),
    } as unknown as Response);

    const result = await fetchMemoryStats();

    expect(result).toEqual({ workingMemorySize: 150, insightsSize: 50, insightsExists: true });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/stats");
    fetchSpy.mockRestore();
  });

  it("calls GET /api/memory/stats with projectId", async () => {
    const { fetchMemoryStats } = await import("../api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ workingMemorySize: 200, insightsSize: 0, insightsExists: false }),
      text: () => Promise.resolve('{"workingMemorySize":200,"insightsSize":0,"insightsExists":false}'),
    } as unknown as Response);

    const result = await fetchMemoryStats("proj_abc");

    expect(result).toEqual({ workingMemorySize: 200, insightsSize: 0, insightsExists: false });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/stats");
    expect(call[0]).toContain("projectId=proj_abc");
    fetchSpy.mockRestore();
  });
});

