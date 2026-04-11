import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockIsDiscoveryActive = vi.fn().mockReturnValue(false);
const mockGetDiscoveryConfig = vi.fn().mockReturnValue(null);
const mockStartDiscovery = vi.fn().mockResolvedValue(undefined);
const mockStopDiscovery = vi.fn();
const mockGetDiscoveredNodes = vi.fn().mockReturnValue([]);
const mockRegisterNode = vi.fn();
const mockCheckNodeHealth = vi.fn().mockResolvedValue("online");

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockInit,
      close: mockClose,
      isDiscoveryActive: mockIsDiscoveryActive,
      getDiscoveryConfig: mockGetDiscoveryConfig,
      startDiscovery: mockStartDiscovery,
      stopDiscovery: mockStopDiscovery,
      getDiscoveredNodes: mockGetDiscoveredNodes,
      registerNode: mockRegisterNode,
      checkNodeHealth: mockCheckNodeHealth,
    })),
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1222";
  }

  getFusionDir(): string {
    return "/tmp/fn-1222/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    };
  }

  getMissionStore() {
    return {
      listMissions: vi.fn().mockResolvedValue([]),
      createMission: vi.fn(),
      getMission: vi.fn(),
      updateMission: vi.fn(),
      deleteMission: vi.fn(),
      listTemplates: vi.fn().mockResolvedValue([]),
      createTemplate: vi.fn(),
      getTemplate: vi.fn(),
      updateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
      instantiateMission: vi.fn(),
    };
  }

  async listTasks(): Promise<Task[]> {
    return [];
  }
}

describe("Discovery routes", () => {
  const app = createServer(new MockStore() as any);

  beforeEach(() => {
    vi.clearAllMocks();

    mockIsDiscoveryActive.mockReturnValue(false);
    mockGetDiscoveryConfig.mockReturnValue(null);
    mockGetDiscoveredNodes.mockReturnValue([]);
    mockRegisterNode.mockResolvedValue({
      id: "node_remote_1",
      name: "remote-a",
      type: "remote",
      url: "http://192.168.1.40:4040",
      status: "offline",
      maxConcurrent: 2,
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z",
    });
  });

  it("GET /api/discovery/status returns active state and config", async () => {
    mockIsDiscoveryActive.mockReturnValue(true);
    mockGetDiscoveryConfig.mockReturnValue({
      broadcast: true,
      listen: true,
      serviceType: "_fusion._tcp",
      port: 4040,
      staleTimeoutMs: 300_000,
    });

    const res = await request(app, "GET", "/api/discovery/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      config: {
        broadcast: true,
        listen: true,
        serviceType: "_fusion._tcp",
        port: 4040,
        staleTimeoutMs: 300_000,
      },
    });
  });

  it("POST /api/discovery/start uses defaults", async () => {
    const res = await request(
      app,
      "POST",
      "/api/discovery/start",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(mockStartDiscovery).toHaveBeenCalledWith({
      broadcast: true,
      listen: true,
      serviceType: "_fusion._tcp",
      port: 4040,
      staleTimeoutMs: 300_000,
    });
    expect(res.body).toEqual({
      success: true,
      config: {
        broadcast: true,
        listen: true,
        serviceType: "_fusion._tcp",
        port: 4040,
        staleTimeoutMs: 300_000,
      },
    });
  });

  it("POST /api/discovery/start accepts custom config", async () => {
    const res = await request(
      app,
      "POST",
      "/api/discovery/start",
      JSON.stringify({
        broadcast: false,
        listen: true,
        port: 5050,
        serviceType: "_custom._tcp",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(mockStartDiscovery).toHaveBeenCalledWith({
      broadcast: false,
      listen: true,
      serviceType: "_custom._tcp",
      port: 5050,
      staleTimeoutMs: 300_000,
    });
  });

  it("POST /api/discovery/stop stops discovery", async () => {
    const res = await request(app, "POST", "/api/discovery/stop", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(mockStopDiscovery).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ success: true });
  });

  it("GET /api/discovery/nodes returns discovered nodes", async () => {
    mockGetDiscoveredNodes.mockReturnValue([
      {
        name: "remote-a",
        host: "192.168.1.40",
        port: 4040,
        nodeType: "remote",
        nodeId: "node_remote_1",
        discoveredAt: "2026-04-08T00:00:00.000Z",
        lastSeenAt: "2026-04-08T00:01:00.000Z",
      },
    ]);

    const res = await request(app, "GET", "/api/discovery/nodes");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        name: "remote-a",
        host: "192.168.1.40",
        port: 4040,
        nodeType: "remote",
        nodeId: "node_remote_1",
        discoveredAt: "2026-04-08T00:00:00.000Z",
        lastSeenAt: "2026-04-08T00:01:00.000Z",
      },
    ]);
  });

  it("POST /api/discovery/connect registers discovered node with normalized URL", async () => {
    const res = await request(
      app,
      "POST",
      "/api/discovery/connect",
      JSON.stringify({
        name: "remote-a",
        host: "http://192.168.1.40/path",
        port: 4040,
        apiKey: "secret",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(mockRegisterNode).toHaveBeenCalledWith({
      name: "remote-a",
      type: "remote",
      url: "http://192.168.1.40:4040",
      apiKey: "secret",
    });
    expect(mockCheckNodeHealth).toHaveBeenCalledWith("node_remote_1");
  });

  it("POST /api/discovery/connect maps duplicate-name errors to 409", async () => {
    mockRegisterNode.mockRejectedValue(new Error("Node already exists with name: remote-a"));

    const res = await request(
      app,
      "POST",
      "/api/discovery/connect",
      JSON.stringify({
        name: "remote-a",
        host: "192.168.1.40",
        port: 4040,
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(409);
  });
});
