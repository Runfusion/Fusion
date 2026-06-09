import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeConfig } from "@fusion/core";
import { remoteNodeLog } from "../../logger.js";
import { RemoteNodeRuntime } from "../../runtimes/remote-node-runtime.js";

const mockHealth = vi.hoisted(() => vi.fn());
const mockGetMetrics = vi.hoisted(() => vi.fn());
const mockStreamEvents = vi.hoisted(() => vi.fn());
const mockPollPendingAssignments = vi.hoisted(() => vi.fn());

vi.mock("../../runtimes/remote-node-client.js", () => ({
  RemoteNodeClient: vi.fn().mockImplementation(function () {
    return {
      health: mockHealth,
      getMetrics: mockGetMetrics,
      streamEvents: mockStreamEvents,
      pollPendingAssignments: mockPollPendingAssignments,
    };
  }),
}));

const NOW = "2026-05-16T00:00:00.000Z";

function createNode(overrides?: Partial<NodeConfig>): NodeConfig {
  return {
    id: "node-b",
    name: "Node B",
    type: "remote",
    url: "https://node-b.example.com",
    apiKey: "k",
    status: "online",
    maxConcurrent: 2,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function* stream(events: unknown[], signal?: AbortSignal): AsyncIterable<unknown> {
  for (const event of events) yield event;
  while (!signal?.aborted) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("reliability: cross-node assignment wake", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockHealth.mockReset();
    mockGetMetrics.mockReset();
    mockStreamEvents.mockReset();
    mockPollPendingAssignments.mockReset();
    mockHealth.mockResolvedValue({ status: "ok", version: "1.0.0", uptime: 1 });
    mockGetMetrics.mockResolvedValue({ inFlightTasks: 0, activeAgents: 0, lastActivityAt: NOW });
    mockStreamEvents.mockImplementation(({ signal }: { signal?: AbortSignal } = {}) => stream([], signal));
    mockPollPendingAssignments.mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("healthy push path wakes once with cross-node-push source", async () => {
    mockStreamEvents.mockImplementation(({ signal }: { signal?: AbortSignal } = {}) =>
      stream([{ type: "task:assigned", payload: { taskId: "FN-1", agentId: "agent-1", assignedAt: NOW }, timestamp: NOW }], signal)
    );

    const runtime = new RemoteNodeRuntime({ nodeConfig: createNode(), projectId: "p", projectName: "P" });
    (runtime as unknown as { reconnectBaseDelayMs: number }).reconnectBaseDelayMs = 1;
    (runtime as unknown as { maxReconnectDelayMs: number }).maxReconnectDelayMs = 1;
    (runtime as unknown as { maxReconnectAttempts: number }).maxReconnectAttempts = 1;
    const wakes: Array<{ taskId: string; agentId: string; source?: string }> = [];
    runtime.on("task:assigned", (wake) => wakes.push(wake));

    await runtime.start();
    await vi.waitFor(() => {
      expect(wakes).toEqual([{ taskId: "FN-1", agentId: "agent-1", assignedAt: NOW, source: "cross-node-push" }]);
    });
    await runtime.stop();
  });

  it("degraded transport uses poll fallback within 10s and dedupes replay", async () => {
    vi.useFakeTimers();
    mockStreamEvents.mockImplementation(async function* () {
      throw new Error("stream offline");
    });
    mockPollPendingAssignments
      .mockResolvedValueOnce([{ taskId: "FN-2", agentId: "agent-2", assignedAt: NOW }])
      .mockResolvedValue([{ taskId: "FN-2", agentId: "agent-2", assignedAt: NOW }]);

    const runtime = new RemoteNodeRuntime({ nodeConfig: createNode(), projectId: "p2", projectName: "P2" });
    (runtime as unknown as { reconnectBaseDelayMs: number }).reconnectBaseDelayMs = 5_000;
    (runtime as unknown as { maxReconnectAttempts: number }).maxReconnectAttempts = 2;

    const wakes: unknown[] = [];
    runtime.on("task:assigned", (wake) => wakes.push(wake));

    await runtime.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ taskId: "FN-2", source: "cross-node-poll" });
    await runtime.stop();
  });

  it("missed-wake reconciliation emits one reconcile wake after restoration", async () => {
    vi.useFakeTimers();
    mockStreamEvents.mockImplementation(async function* () {
      throw new Error("down");
    });
    const runtime = new RemoteNodeRuntime({ nodeConfig: createNode(), projectId: "p3", projectName: "P3" });
    (runtime as unknown as { reconnectBaseDelayMs: number }).reconnectBaseDelayMs = 1;
    (runtime as unknown as { maxReconnectDelayMs: number }).maxReconnectDelayMs = 1;
    (runtime as unknown as { maxReconnectAttempts: number }).maxReconnectAttempts = 1;

    const wakes: unknown[] = [];
    const auditRows: unknown[] = [];
    runtime.on("task:assigned", (wake) => {
      wakes.push(wake);
      if ((wake as { source?: string }).source === "cross-node-reconcile") {
        auditRows.push({ event: "wake:cross-node-reconcile", wake });
      }
    });

    await runtime.start();
    await vi.waitFor(() => expect(runtime.getStatus()).toBe("errored"));

    await runtime.reconcileAssignments([{ taskId: "FN-3", agentId: "agent-3", assignedAt: NOW }]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ taskId: "FN-3", source: "cross-node-reconcile" });
    expect(auditRows).toHaveLength(1);
    await runtime.stop();
  });

  it("no-wake invariant: same assignment does not double fire, newer assignedAt does", async () => {
    mockStreamEvents.mockImplementation(({ signal }: { signal?: AbortSignal } = {}) =>
      stream(
        [
          { type: "task:assigned", payload: { taskId: "FN-4", agentId: "agent-4", assignedAt: NOW }, timestamp: NOW },
          { type: "task:assigned", payload: { taskId: "FN-4", agentId: "agent-4", assignedAt: NOW }, timestamp: NOW },
          { type: "task:assigned", payload: { taskId: "FN-4", agentId: "agent-4", assignedAt: "2026-05-16T00:00:01.000Z" }, timestamp: NOW },
        ],
        signal
      )
    );

    const runtime = new RemoteNodeRuntime({ nodeConfig: createNode(), projectId: "p4", projectName: "P4" });
    (runtime as unknown as { reconnectBaseDelayMs: number }).reconnectBaseDelayMs = 1;
    (runtime as unknown as { maxReconnectDelayMs: number }).maxReconnectDelayMs = 1;
    (runtime as unknown as { maxReconnectAttempts: number }).maxReconnectAttempts = 1;
    const wakes: unknown[] = [];
    runtime.on("task:assigned", (wake) => wakes.push(wake));

    await runtime.start();
    await vi.waitFor(() => {
      expect(wakes).toHaveLength(2);
    });
    await runtime.stop();
  });

  it("emits wake-trigger diagnostics with source and taskId", async () => {
    const logSpy = vi.spyOn(remoteNodeLog, "log");
    mockStreamEvents.mockImplementation(({ signal }: { signal?: AbortSignal } = {}) =>
      stream([{ type: "task:assigned", payload: { taskId: "FN-5", agentId: "agent-5", assignedAt: NOW }, timestamp: NOW }], signal)
    );

    const runtime = new RemoteNodeRuntime({ nodeConfig: createNode(), projectId: "p5", projectName: "P5" });
    (runtime as unknown as { reconnectBaseDelayMs: number }).reconnectBaseDelayMs = 1;
    (runtime as unknown as { maxReconnectDelayMs: number }).maxReconnectDelayMs = 1;
    (runtime as unknown as { maxReconnectAttempts: number }).maxReconnectAttempts = 1;
    await runtime.start();
    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[wake-trigger-diagnostics] source=cross-node-push taskId=FN-5"));
    });
    await runtime.stop();
  });
});
