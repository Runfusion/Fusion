import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeConfig } from "@fusion/core";
import type { RuntimeMetrics } from "../../project-runtime.js";
import { RemoteNodeRuntime } from "../remote-node-runtime.js";

const mockClientConstructor = vi.hoisted(() => vi.fn());
const mockHealth = vi.hoisted(() => vi.fn());
const mockGetMetrics = vi.hoisted(() => vi.fn());
const mockStreamEvents = vi.hoisted(() => vi.fn());

vi.mock("../remote-node-client.js", () => ({
  RemoteNodeClient: vi.fn().mockImplementation((options: unknown) => {
    mockClientConstructor(options);
    return {
      health: mockHealth,
      getMetrics: mockGetMetrics,
      streamEvents: mockStreamEvents,
    };
  }),
}));

const NOW = "2026-04-08T00:00:00.000Z";

function createNode(overrides?: Partial<NodeConfig>): NodeConfig {
  return {
    id: "node_remote_1",
    name: "Remote Node",
    type: "remote",
    url: "https://remote.example.com",
    apiKey: "token-123",
    status: "online",
    maxConcurrent: 4,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function* idleStream(signal?: AbortSignal): AsyncIterable<unknown> {
  while (!signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Yield to satisfy TypeScript/ESLint generator requirements
  yield;
}

async function* eventStream(events: unknown[], signal?: AbortSignal): AsyncIterable<unknown> {
  for (const event of events) {
    yield event;
  }

  while (!signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("RemoteNodeRuntime", () => {
  beforeEach(() => {
    mockClientConstructor.mockReset();
    mockHealth.mockReset();
    mockGetMetrics.mockReset();
    mockStreamEvents.mockReset();

    mockHealth.mockResolvedValue({ status: "ok", version: "1.0.0", uptime: 100 });
    mockGetMetrics.mockResolvedValue({
      inFlightTasks: 1,
      activeAgents: 2,
      lastActivityAt: NOW,
    } satisfies RuntimeMetrics);
    mockStreamEvents.mockImplementation(({ signal }: { signal?: AbortSignal } = {}) =>
      idleStream(signal)
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("start() transitions stopped -> starting -> active and starts stream", async () => {
    const runtime = new RemoteNodeRuntime({
      nodeConfig: createNode(),
      projectId: "proj_1",
      projectName: "Project 1",
    });

    const healthEvents: string[] = [];
    runtime.on("health-changed", ({ status }) => {
      healthEvents.push(status);
    });

    await runtime.start();

    expect(runtime.getStatus()).toBe("active");
    expect(healthEvents).toEqual(["starting", "active"]);
    expect(mockHealth).toHaveBeenCalled();
    expect(mockStreamEvents).toHaveBeenCalled();
    expect(mockClientConstructor).toHaveBeenCalledWith({
      baseUrl: "https://remote.example.com",
      apiKey: "token-123",
    });

    await runtime.stop();
  });

  it("stop() transitions to stopped and is idempotent", async () => {
    const runtime = new RemoteNodeRuntime({
      nodeConfig: createNode(),
      projectId: "proj_2",
      projectName: "Project 2",
    });

    await runtime.start();
    await runtime.stop();

    expect(runtime.getStatus()).toBe("stopped");

    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("getTaskStore() throws descriptive error", () => {
    const runtime = new RemoteNodeRuntime({
      nodeConfig: createNode(),
      projectId: "proj_3",
      projectName: "Project 3",
    });

    expect(() => runtime.getTaskStore()).toThrow(
      "TaskStore not accessible for remote node runtime"
    );
  });

  it("getScheduler() throws descriptive error", () => {
    const runtime = new RemoteNodeRuntime({
      nodeConfig: createNode(),
      projectId: "proj_4",
      projectName: "Project 4",
    });

    expect(() => runtime.getScheduler()).toThrow("Scheduler not accessible for remote node runtime");
  });

  it("getMetrics() returns fetched metrics on success and fallback on failure", async () => {
    const runtime = new RemoteNodeRuntime({
      nodeConfig: createNode(),
      projectId: "proj_5",
      projectName: "Project 5",
    });

    await runtime.start();

    expect(runtime.getMetrics()).toEqual({
      inFlightTasks: 1,
      activeAgents: 2,
      lastActivityAt: NOW,
    });

    mockGetMetrics.mockRejectedValueOnce(new Error("metrics unavailable"));

    runtime.getMetrics();
    await Promise.resolve();

    expect(runtime.getMetrics()).toEqual({
      inFlightTasks: 0,
      activeAgents: 0,
      lastActivityAt: NOW,
    });

    await runtime.stop();
  });

  it("forwards remote task and error events", async () => {
    const createdHandler = vi.fn();
    const movedHandler = vi.fn();
    const updatedHandler = vi.fn();
    const errorHandler = vi.fn();

    mockStreamEvents.mockImplementation(({ signal }: { signal?: AbortSignal } = {}) =>
      eventStream(
        [
          {
            type: "task:created",
            payload: { id: "KB-1" },
            timestamp: NOW,
          },
          {
            type: "task:moved",
            payload: { task: { id: "KB-1" }, from: "todo", to: "in-progress" },
            timestamp: NOW,
          },
          {
            type: "task:updated",
            payload: { id: "KB-1", column: "done" },
            timestamp: NOW,
          },
          {
            type: "error",
            payload: { message: "boom" },
            timestamp: NOW,
          },
        ],
        signal
      )
    );

    const runtime = new RemoteNodeRuntime({
      nodeConfig: createNode(),
      projectId: "proj_6",
      projectName: "Project 6",
    });

    runtime.on("task:created", createdHandler);
    runtime.on("task:moved", movedHandler);
    runtime.on("task:updated", updatedHandler);
    runtime.on("error", errorHandler);

    await runtime.start();

    await vi.waitFor(() => {
      expect(createdHandler).toHaveBeenCalledWith({ id: "KB-1" });
      expect(movedHandler).toHaveBeenCalledWith({
        task: { id: "KB-1" },
        from: "todo",
        to: "in-progress",
      });
      expect(updatedHandler).toHaveBeenCalledWith({ id: "KB-1", column: "done" });
      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
    });

    await runtime.stop();
  });

  it("reconnects when stream ends unexpectedly and transitions to errored after max attempts", async () => {
    mockStreamEvents.mockImplementation(async function* () {
      // Immediate end to force reconnect loop.
    });

    const runtime = new RemoteNodeRuntime({
      nodeConfig: createNode(),
      projectId: "proj_7",
      projectName: "Project 7",
    });

    (runtime as unknown as { reconnectBaseDelayMs: number }).reconnectBaseDelayMs = 1;
    (runtime as unknown as { maxReconnectDelayMs: number }).maxReconnectDelayMs = 1;
    (runtime as unknown as { maxReconnectAttempts: number }).maxReconnectAttempts = 3;

    await runtime.start();

    await vi.waitFor(() => {
      expect(runtime.getStatus()).toBe("errored");
    });

    expect(mockStreamEvents.mock.calls.length).toBeGreaterThanOrEqual(3);

    await runtime.stop();
  });

  it("validates remote node config on start", async () => {
    const runtime = new RemoteNodeRuntime({
      nodeConfig: createNode({ type: "local", url: undefined, apiKey: undefined }),
      projectId: "proj_8",
      projectName: "Project 8",
    });

    await expect(runtime.start()).rejects.toThrow("requires a remote node configuration");
  });
});
