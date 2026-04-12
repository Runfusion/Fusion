import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CentralCore, NodeConfig } from "@fusion/core";
import { NodeHealthMonitor } from "./node-health-monitor.js";

const NOW = "2026-04-08T00:00:00.000Z";

function createNode(overrides: Partial<NodeConfig>): NodeConfig {
  return {
    id: "node-id",
    name: "Node",
    type: "remote",
    status: "online",
    maxConcurrent: 4,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("NodeHealthMonitor", () => {
  let mockCentralCore: CentralCore;
  let listNodesMock: ReturnType<typeof vi.fn>;
  let checkNodeHealthMock: ReturnType<typeof vi.fn>;
  let monitor: NodeHealthMonitor;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();

    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    listNodesMock = vi.fn().mockResolvedValue([
      createNode({ id: "node-local", name: "Local Node", type: "local", status: "online" }),
      createNode({ id: "node-remote", name: "Remote Node", type: "remote", status: "online" }),
    ]);
    checkNodeHealthMock = vi.fn().mockResolvedValue("online");

    mockCentralCore = {
      listNodes: listNodesMock,
      checkNodeHealth: checkNodeHealthMock,
    } as unknown as CentralCore;

    monitor = new NodeHealthMonitor(mockCentralCore, { checkIntervalMs: 1_000 });
  });

  afterEach(async () => {
    await monitor.stop();
    vi.useRealTimers();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("start() sets interval and checks only remote nodes", async () => {
    await monitor.start();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(listNodesMock).toHaveBeenCalled();
    expect(checkNodeHealthMock).toHaveBeenCalledTimes(1);
    expect(checkNodeHealthMock).toHaveBeenCalledWith("node-remote");
  });

  it("stop() clears interval", async () => {
    await monitor.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(checkNodeHealthMock).toHaveBeenCalledTimes(1);

    await monitor.stop();
    checkNodeHealthMock.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(checkNodeHealthMock).not.toHaveBeenCalled();
  });

  it("checkAllNodes() checks each remote node and skips local nodes", async () => {
    await monitor.start();

    const summary = await monitor.checkAllNodes();

    expect(checkNodeHealthMock).toHaveBeenCalledTimes(1);
    expect(checkNodeHealthMock).toHaveBeenCalledWith("node-remote");
    expect(summary).toEqual({
      checked: 1,
      online: 1,
      offline: 0,
      error: 0,
      connecting: 0,
    });
  });

  it("logs warning when node transitions from online to offline", async () => {
    checkNodeHealthMock.mockResolvedValue("offline");

    await monitor.start();
    await monitor.checkAllNodes();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[node-health-monitor] Remote node Remote Node (node-remote) degraded")
    );
    expect(monitor.getNodeHealth("node-remote")).toBe("offline");
  });

  it("logs recovery when node transitions back to online", async () => {
    checkNodeHealthMock.mockResolvedValueOnce("offline").mockResolvedValueOnce("online");

    await monitor.start();
    await monitor.checkAllNodes();
    await monitor.checkAllNodes();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[node-health-monitor] Remote node Remote Node (node-remote) recovered")
    );
    expect(monitor.getNodeHealth("node-remote")).toBe("online");
  });

  it("is a no-op when no remote nodes are registered", async () => {
    listNodesMock.mockResolvedValue([
      createNode({ id: "node-local-only", name: "Local Only", type: "local", status: "online" }),
    ]);

    await monitor.start();
    const summary = await monitor.checkAllNodes();

    expect(checkNodeHealthMock).not.toHaveBeenCalled();
    expect(summary).toEqual({
      checked: 0,
      online: 0,
      offline: 0,
      error: 0,
      connecting: 0,
    });
  });
});
