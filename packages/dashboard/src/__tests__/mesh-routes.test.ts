import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";

// Request helper type for the test-request module
type TestRequestFn = (
  app: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>
) => Promise<{ status: number; body: unknown; headers: Record<string, string | string[] | undefined> }>;

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockMergePeers = vi.fn().mockResolvedValue({ added: [], updated: [] });
const mockGetAllKnownPeerInfo = vi.fn().mockResolvedValue([]);
const mockGetLocalPeerInfo = vi.fn();
const mockGetNode = vi.fn();
const mockUpdateNode = vi.fn();
const mockGetLocalNode = vi.fn();

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockInit,
      close: mockClose,
      mergePeers: mockMergePeers,
      getAllKnownPeerInfo: mockGetAllKnownPeerInfo,
      getLocalPeerInfo: mockGetLocalPeerInfo,
      getNode: mockGetNode,
      updateNode: mockUpdateNode,
      getLocalNode: mockGetLocalNode,
    })),
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1224";
  }

  getFusionDir(): string {
    return "/tmp/fn-1224/.fusion";
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

function makePeerInfo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    nodeId: "node_peer_1",
    nodeName: "Peer Node 1",
    nodeUrl: "https://peer-1.example.com",
    status: "online",
    metrics: null,
    lastSeen: "2026-04-01T12:00:00.000Z",
    maxConcurrent: 2,
    ...overrides,
  };
}

function makeNodeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "node_remote_1",
    name: "Remote Node",
    type: "remote",
    url: "https://remote.example.com",
    apiKey: undefined,
    status: "online",
    maxConcurrent: 2,
    createdAt: "2026-04-01T10:00:00.000Z",
    updatedAt: "2026-04-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("POST /api/mesh/sync", () => {
  let app: ReturnType<typeof createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset mock implementations
    mockInit.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockMergePeers.mockResolvedValue({ added: [], updated: [] });
    mockGetAllKnownPeerInfo.mockResolvedValue([]);
    mockGetLocalPeerInfo.mockResolvedValue({
      nodeId: "node_local",
      nodeName: "local",
      nodeUrl: "",
      status: "online",
      metrics: null,
      lastSeen: "2026-04-01T12:00:00.000Z",
      maxConcurrent: 4,
    });
    mockGetNode.mockResolvedValue(undefined);
    mockUpdateNode.mockResolvedValue({ id: "node_remote", status: "online" });
    mockGetLocalNode.mockResolvedValue({
      id: "node_local",
      name: "local",
      type: "local",
      status: "online",
      maxConcurrent: 4,
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T12:00:00.000Z",
    });

    const store = new MockStore();
    app = createServer(store);
  });

  it("should merge peers and return sync response", async () => {
    const peers = [makePeerInfo({ nodeId: "node_new" })];
    const allKnownPeers = [
      makePeerInfo({ nodeId: "node_local", nodeName: "local" }),
      makePeerInfo({ nodeId: "node_new" }),
      makePeerInfo({ nodeId: "node_existing" }),
    ];

    mockMergePeers.mockResolvedValue({ added: ["node_new"], updated: [] });
    mockGetAllKnownPeerInfo.mockResolvedValue(allKnownPeers);

    const response = await request(
      app,
      "POST",
      "/api/mesh/sync",
      JSON.stringify({
        senderNodeId: "node_remote",
        senderNodeUrl: "https://remote.example.com",
        knownPeers: peers,
        timestamp: "2026-04-01T12:00:00.000Z",
      }),
      { "Content-Type": "application/json" }
    );

    expect(response.status).toBe(200);
    expect(mockMergePeers).toHaveBeenCalledWith(peers);
    expect(response.body).toMatchObject({
      senderNodeId: "node_local",
      knownPeers: allKnownPeers,
      timestamp: expect.any(String),
    });
    expect((response.body as any).newPeers).toHaveLength(2); // node_local and node_existing (node_new was in knownPeers)
  });

  it("should reject missing senderNodeId with 400", async () => {
    const response = await request(
      app,
      "POST",
      "/api/mesh/sync",
      JSON.stringify({ knownPeers: [] }),
      { "Content-Type": "application/json" }
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "senderNodeId is required" });
  });

  it("should reject non-array knownPeers with 400", async () => {
    const response = await request(
      app,
      "POST",
      "/api/mesh/sync",
      JSON.stringify({
        senderNodeId: "node_remote",
        knownPeers: "not-an-array",
      }),
      { "Content-Type": "application/json" }
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "knownPeers must be an array" });
  });

  it("should reject malformed peer entries with 400", async () => {
    const response = await request(
      app,
      "POST",
      "/api/mesh/sync",
      JSON.stringify({
        senderNodeId: "node_remote",
        knownPeers: [
          { nodeId: "valid" }, // missing nodeName and status
        ],
      }),
      { "Content-Type": "application/json" }
    );

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("Each knownPeers entry must have");
  });

  it("should update sender node status to online", async () => {
    mockGetNode.mockResolvedValue(makeNodeConfig({ id: "node_remote", status: "offline" }));

    const response = await request(
      app,
      "POST",
      "/api/mesh/sync",
      JSON.stringify({
        senderNodeId: "node_remote",
        senderNodeUrl: "https://remote.example.com",
        knownPeers: [],
        timestamp: "2026-04-01T12:00:00.000Z",
      }),
      { "Content-Type": "application/json" }
    );

    expect(response.status).toBe(200);
    expect(mockUpdateNode).toHaveBeenCalledWith("node_remote", { status: "online" });
  });

  it("should silently skip update if sender node not found", async () => {
    mockGetNode.mockResolvedValue(undefined);
    mockUpdateNode.mockRejectedValue(new Error("Node not found"));

    // Should not throw, just silently skip
    const response = await request(
      app,
      "POST",
      "/api/mesh/sync",
      JSON.stringify({
        senderNodeId: "node_unknown",
        senderNodeUrl: "https://unknown.example.com",
        knownPeers: [],
        timestamp: "2026-04-01T12:00:00.000Z",
      }),
      { "Content-Type": "application/json" }
    );

    expect(response.status).toBe(200);
  });

  it("should validate API key when sender has one configured", async () => {
    mockGetNode.mockResolvedValue(makeNodeConfig({ apiKey: "secret-key" }));

    const response = await request(
      app,
      "POST",
      "/api/mesh/sync",
      JSON.stringify({
        senderNodeId: "node_remote",
        senderNodeUrl: "https://remote.example.com",
        knownPeers: [],
        timestamp: "2026-04-01T12:00:00.000Z",
      }),
      { "Content-Type": "application/json", "Authorization": "Bearer wrong-key" }
    );

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: "Unauthorized" });
  });

  it("should accept request with correct API key", async () => {
    mockGetNode.mockResolvedValue(makeNodeConfig({ apiKey: "correct-key" }));

    const response = await request(
      app,
      "POST",
      "/api/mesh/sync",
      JSON.stringify({
        senderNodeId: "node_remote",
        senderNodeUrl: "https://remote.example.com",
        knownPeers: [],
        timestamp: "2026-04-01T12:00:00.000Z",
      }),
      { "Content-Type": "application/json", "Authorization": "Bearer correct-key" }
    );

    expect(response.status).toBe(200);
    expect(mockMergePeers).toHaveBeenCalled();
  });

  it("should allow request without auth when sender has no API key", async () => {
    mockGetNode.mockResolvedValue(makeNodeConfig({ apiKey: undefined }));

    const response = await request(
      app,
      "POST",
      "/api/mesh/sync",
      JSON.stringify({
        senderNodeId: "node_remote",
        senderNodeUrl: "https://remote.example.com",
        knownPeers: [],
        timestamp: "2026-04-01T12:00:00.000Z",
      }),
      { "Content-Type": "application/json" }
    );

    expect(response.status).toBe(200);
    expect(mockMergePeers).toHaveBeenCalled();
  });

  it("should handle empty knownPeers array", async () => {
    const localPeer = makePeerInfo({ nodeId: "node_local", nodeName: "local" });
    mockGetAllKnownPeerInfo.mockResolvedValue([localPeer]);

    const response = await request(
      app,
      "POST",
      "/api/mesh/sync",
      JSON.stringify({
        senderNodeId: "node_remote",
        senderNodeUrl: "https://remote.example.com",
        knownPeers: [],
        timestamp: "2026-04-01T12:00:00.000Z",
      }),
      { "Content-Type": "application/json" }
    );

    expect(response.status).toBe(200);
    expect(mockMergePeers).toHaveBeenCalledWith([]);
    expect((response.body as any).newPeers).toHaveLength(1); // All local peers are "new" to sender
    expect((response.body as any).newPeers[0].nodeId).toBe("node_local");
  });

  it("should compute newPeers correctly - sender knows some peers", async () => {
    const allKnownPeers = [
      makePeerInfo({ nodeId: "node_local", nodeName: "local" }),
      makePeerInfo({ nodeId: "node_a" }),
      makePeerInfo({ nodeId: "node_b" }),
      makePeerInfo({ nodeId: "node_c" }),
    ];

    mockGetAllKnownPeerInfo.mockResolvedValue(allKnownPeers);

    // Sender knows node_a and node_b, but not node_c or node_local
    const response = await request(
      app,
      "POST",
      "/api/mesh/sync",
      JSON.stringify({
        senderNodeId: "node_remote",
        senderNodeUrl: "https://remote.example.com",
        knownPeers: [
          makePeerInfo({ nodeId: "node_a" }),
          makePeerInfo({ nodeId: "node_b" }),
        ],
        timestamp: "2026-04-01T12:00:00.000Z",
      }),
      { "Content-Type": "application/json" }
    );

    expect(response.status).toBe(200);
    expect((response.body as any).newPeers).toHaveLength(2);
    const newPeerIds = (response.body as any).newPeers.map((p: { nodeId: string }) => p.nodeId);
    expect(newPeerIds).toContain("node_local");
    expect(newPeerIds).toContain("node_c");
    expect(newPeerIds).not.toContain("node_a");
    expect(newPeerIds).not.toContain("node_b");
  });
});
