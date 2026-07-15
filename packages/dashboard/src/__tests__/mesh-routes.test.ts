import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task, TaskStore } from "@fusion/core";
import { createAuthMaterialSnapshot } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";
import type { RuntimeLogger } from "../runtime-logger.js";

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
const mockListNodes = vi.fn();
const mockGetLocalMeshSnapshot = vi.fn();
const mockGetSettingsForSync = vi.fn();
const mockApplyRemoteSettings = vi.fn();
const mockReserveDistributedTaskId = vi.fn();
const mockCommitDistributedTaskIdReservation = vi.fn();
const mockAbortDistributedTaskIdReservation = vi.fn();
const mockGetDistributedTaskIdState = vi.fn();
const mockApplyReplicatedTaskCreate = vi.fn();
const mockApplyAuthMaterialSnapshot = vi.fn();
const mockGetAuthMaterialSnapshot = vi.fn();

// Mock GlobalSettingsStore
const mockGetSettings = vi.fn().mockResolvedValue({});
const mockGlobalSettingsStore = {
  getSettings: mockGetSettings,
};

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(function () { return {
      init: mockInit,
      close: mockClose,
      mergePeers: mockMergePeers,
      getAllKnownPeerInfo: mockGetAllKnownPeerInfo,
      getLocalPeerInfo: mockGetLocalPeerInfo,
      getNode: mockGetNode,
      updateNode: mockUpdateNode,
      getLocalNode: mockGetLocalNode,
      listNodes: mockListNodes,
      getLocalMeshSnapshot: mockGetLocalMeshSnapshot,
      getSettingsForSync: mockGetSettingsForSync,
      applyRemoteSettings: mockApplyRemoteSettings,
      applyAuthMaterialSnapshot: mockApplyAuthMaterialSnapshot,
      getAuthMaterialSnapshot: mockGetAuthMaterialSnapshot,
    }; }),
    // FNXC:PostgresCutover 2026-07-10: the mesh sync response path constructs a
    // REAL AgentStore for the agents/agentRuns shared-state snapshots; the
    // sqlite runtime is removed on this branch, so a real init() throws and
    // 500s the route. Stub the store surface the route touches.
    AgentStore: vi.fn().mockImplementation(function () { return {
      init: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      getAgentSnapshot: vi.fn(() => undefined),
      getAgentRunSnapshot: vi.fn(() => undefined),
      applyAgentSnapshot: vi.fn(async () => undefined),
      applyAgentRunSnapshot: vi.fn(async () => undefined),
    }; }),
  };
});

// FNXC:ProviderAuth 2026-07-07-00:00: FN-7647 routed register-mesh-routes.ts's inline
// auth-material shared-state domain through @fusion/engine's createFusionAuthStorage() instead of
// a raw AuthStorage.create(getFusionAuthPath()). Mock the factory so mesh sync auth-material writes
// are observable and never touch the real ~/.fusion/agent/auth.json during tests; preserve every
// other real @fusion/engine export other routers rely on at module load time. vi.mock factories are
// hoisted above top-level const declarations, so the referenced mocks must be created via
// vi.hoisted to avoid a temporal-dead-zone ReferenceError.
const { mockMeshAuthStorageSet, mockCreateFusionAuthStorage } = vi.hoisted(() => {
  const mockMeshAuthStorageSet = vi.fn().mockResolvedValue(undefined);
  const mockCreateFusionAuthStorage = vi.fn(() => ({
    set: mockMeshAuthStorageSet,
    get: vi.fn(),
    getApiKey: vi.fn(),
    getOAuthProviders: vi.fn().mockReturnValue([]),
    reload: vi.fn(),
  }));
  return { mockMeshAuthStorageSet, mockCreateFusionAuthStorage };
});

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    createFusionAuthStorage: mockCreateFusionAuthStorage,
  };
});

class MockStore extends EventEmitter {
  /*
  FNXC:PostgresCutover 2026-07-10:
  FNXC:SharedPostgresMultiNode 2026-07-14-23:45:
  createServer requires a project PostgreSQL AsyncDataLayer for ChatStore /
  AgentStore construction. Mesh route tests only exercise HTTP topology and
  allocator routes, so a minimal stub layer is enough — real query paths are
  covered by pg harness suites.
  */
  getAsyncLayer(): { projectId: string } {
    return { projectId: "mesh-routes-test-project" };
  }

  get backendMode(): boolean {
    return true;
  }

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

  getGlobalSettingsStore() {
    return mockGlobalSettingsStore;
  }

  getDistributedTaskIdAllocator() {
    return {
      reserveDistributedTaskId: mockReserveDistributedTaskId,
      commitDistributedTaskIdReservation: mockCommitDistributedTaskIdReservation,
      abortDistributedTaskIdReservation: mockAbortDistributedTaskIdReservation,
      getDistributedTaskIdState: mockGetDistributedTaskIdState,
    };
  }

  async applyReplicatedTaskCreate(payload: unknown): Promise<{ task: Task; applied: boolean }> {
    return mockApplyReplicatedTaskCreate(payload);
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

/*
FNXC:SharedPostgresMultiNode 2026-07-14-23:45:
createServer now boots ChatStore/AiSessionStore against the project PG layer and
fire-and-forgets recoverStaleSessions. Mesh route unit tests inject inert stores
so createServer does not touch a stub layer's query builders.
*/
function createMeshTestServer(store: TaskStore, extra: Record<string, unknown> = {}) {
  const chatStore = Object.assign(new EventEmitter(), {
    deleteSessionsForAgentId: vi.fn().mockResolvedValue(undefined),
  });
  const aiSessionStore = Object.assign(new EventEmitter(), {
    recoverStaleSessions: vi.fn().mockResolvedValue(undefined),
    rehydrateFromStore: vi.fn().mockResolvedValue(0),
    stopScheduledCleanup: vi.fn(),
    cleanupStaleSessions: vi.fn().mockResolvedValue({ terminalDeleted: 0, orphanedDeleted: 0 }),
  });
  return createServer(store, {
    chatStore: chatStore as never,
    aiSessionStore: aiSessionStore as never,
    ...extra,
  });
}

type RuntimeLogEntry = {
  level: "info" | "warn" | "error";
  scope: string;
  message: string;
  context?: Record<string, unknown>;
};

function createRuntimeLoggerHarness(scope = "test"): { logger: RuntimeLogger; entries: RuntimeLogEntry[] } {
  const entries: RuntimeLogEntry[] = [];

  const makeLogger = (currentScope: string): RuntimeLogger => ({
    scope: currentScope,
    info(message, context) {
      entries.push({ level: "info", scope: currentScope, message, context });
    },
    warn(message, context) {
      entries.push({ level: "warn", scope: currentScope, message, context });
    },
    error(message, context) {
      entries.push({ level: "error", scope: currentScope, message, context });
    },
    child(childScope) {
      return makeLogger(`${currentScope}:${childScope}`);
    },
  });

  return {
    logger: makeLogger(scope),
    entries,
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
    mockReserveDistributedTaskId.mockResolvedValue({ reservationId: "res-1", taskId: "FN-001", sequence: 1, expiresAt: "2030-01-01T00:00:00.000Z", committedClusterTaskCount: 0 });
    mockCommitDistributedTaskIdReservation.mockResolvedValue({ reservationId: "res-1", taskId: "FN-001", sequence: 1, committedClusterTaskCount: 1, committedAt: "2030-01-01T00:00:00.000Z" });
    mockAbortDistributedTaskIdReservation.mockResolvedValue({ reservationId: "res-1", taskId: "FN-001", sequence: 1, committedClusterTaskCount: 0, abortedAt: "2030-01-01T00:00:00.000Z" });
    mockGetDistributedTaskIdState.mockResolvedValue({ nextSequence: 2, committedClusterTaskCount: 1, activeReservationCount: 0, burnedReservationCount: 0, lastCommittedTaskId: "FN-001" });
    mockGetLocalNode.mockResolvedValue({
      id: "node_local",
      name: "local",
      type: "local",
      status: "online",
      maxConcurrent: 4,
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T12:00:00.000Z",
    });
    mockListNodes.mockResolvedValue([
      {
        id: "node_local",
        name: "local",
        type: "local",
        status: "online",
        maxConcurrent: 4,
        createdAt: "2026-04-01T10:00:00.000Z",
        updatedAt: "2026-04-01T12:00:00.000Z",
      },
    ]);
    mockGetLocalMeshSnapshot.mockResolvedValue([
      {
        nodeId: "node_local",
        nodeName: "local",
        nodeUrl: undefined,
        nodeType: "local",
        status: "online",
        metrics: null,
        lastSeen: "2026-04-01T12:00:00.000Z",
        connectedAt: "2026-04-01T10:00:00.000Z",
        knownPeers: [],
      },
    ]);

    const store = new MockStore();
    app = createMeshTestServer(store as unknown as TaskStore);
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

  /*
  FNXC:SharedPostgresMultiNode 2026-07-14-23:45:
  Mesh settings gossip is retired. Shared PostgreSQL is the settings SoT; mesh
  sync ignores inbound settings payloads and never echoes settings in responses.
  */
  describe("settings sync (retired under shared PostgreSQL)", () => {
    function makeSettingsPayload(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        exportedAt: "2026-04-01T00:00:00.000Z",
        checksum: "abc123def456",
        version: 1,
        global: {},
        ...overrides,
      };
    }

    beforeEach(() => {
      mockGetSettingsForSync.mockReset();
      mockApplyRemoteSettings.mockReset();
      mockGetSettings.mockReset();
      mockGetAuthMaterialSnapshot.mockReset();
      mockGetAuthMaterialSnapshot.mockReturnValue(undefined);
    });

    it("ignores inbound settings and does not apply or echo them", async () => {
      const remotePayload = makeSettingsPayload({ checksum: "remote-checksum" });
      const runtimeHarness = createRuntimeLoggerHarness();
      const appWithLogger = createMeshTestServer(new MockStore() as unknown as TaskStore, {
        runtimeLogger: runtimeHarness.logger,
      });

      const response = await request(
        appWithLogger,
        "POST",
        "/api/mesh/sync",
        JSON.stringify({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
          settings: remotePayload,
        }),
        { "Content-Type": "application/json" }
      );

      expect(response.status).toBe(200);
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
      expect(mockGetSettingsForSync).not.toHaveBeenCalled();
      expect((response.body as any).settings).toBeUndefined();
      expect(mockMergePeers).toHaveBeenCalled();
      expect(runtimeHarness.entries).toContainEqual(
        expect.objectContaining({
          level: "info",
          scope: "test:routes:remote-route:mesh-sync",
          message: "Ignored inbound settings payload — settings live in shared PostgreSQL",
          context: expect.objectContaining({
            nodeId: "node_remote",
            upstreamPath: "/api/mesh/sync",
            operationStage: "settings-sync",
          }),
        }),
      );
    });

    it("does not include settings in response when request has no settings", async () => {
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
      expect((response.body as any).settings).toBeUndefined();
      expect(mockGetSettingsForSync).not.toHaveBeenCalled();
    });
  });

  // ── FN-7647 Symptom Verification: auth-material shared-state sync ─────────────
  // Original symptom (FN-7646 class): a raw independent AuthStorage instance can persist a stale
  // in-memory snapshot over ~/.fusion/agent/auth.json, wiping a key another process just saved.
  // Asserts the mesh sync auth-material domain writes via the coordinated createFusionAuthStorage()
  // proxy (not a raw instance) and that an unrelated provider's saved credential survives the write.
  describe("auth-material shared-state sync", () => {
    beforeEach(() => {
      mockApplyAuthMaterialSnapshot.mockReset();
      mockCreateFusionAuthStorage.mockClear();
      mockMeshAuthStorageSet.mockReset().mockResolvedValue(undefined);
    });

    it("writes received auth-material credentials via the coordinated createFusionAuthStorage() proxy", async () => {
      mockApplyAuthMaterialSnapshot.mockReturnValue({
        success: true,
        authCount: 1,
        providerAuth: { anthropic: { type: "api_key", key: "sk-ant-mesh-received" } },
      });

      const authMaterial = createAuthMaterialSnapshot({
        anthropic: { type: "api_key", key: "sk-ant-mesh-received" },
      });

      const response = await request(
        app,
        "POST",
        "/api/mesh/sync",
        JSON.stringify({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
          sharedState: { authMaterial },
        }),
        { "Content-Type": "application/json" }
      );

      expect(response.status).toBe(200);
      expect(mockApplyAuthMaterialSnapshot).toHaveBeenCalledWith(authMaterial);
      // Proves the write path is the coordinated proxy, not a raw independent AuthStorage instance.
      expect(mockCreateFusionAuthStorage).toHaveBeenCalled();
      expect(mockMeshAuthStorageSet).toHaveBeenCalledWith("anthropic", { type: "api_key", key: "sk-ant-mesh-received" });
    });

    it("concurrent-writer survival: an unrelated provider's saved key is never clobbered by the mesh sync write", async () => {
      mockApplyAuthMaterialSnapshot.mockReturnValue({
        success: true,
        authCount: 1,
        providerAuth: { anthropic: { type: "api_key", key: "sk-ant-mesh-received" } },
      });

      // Simulate another Fusion instance's provider credential already persisted on disk by having
      // the mocked coordinated proxy merge per-provider (as the real reload-before-persist proxy
      // does) rather than overwrite the whole file.
      const diskState: Record<string, unknown> = {
        openai: { type: "api_key", key: "sk-openai-from-other-instance" },
      };
      mockMeshAuthStorageSet.mockImplementation(async (providerId: string, credential: unknown) => {
        diskState[providerId] = credential;
      });

      const authMaterial = createAuthMaterialSnapshot({
        anthropic: { type: "api_key", key: "sk-ant-mesh-received" },
      });

      const response = await request(
        app,
        "POST",
        "/api/mesh/sync",
        JSON.stringify({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
          sharedState: { authMaterial },
        }),
        { "Content-Type": "application/json" }
      );

      expect(response.status).toBe(200);
      // The unrelated provider saved by another instance before this handler ran must still be present.
      expect(diskState.openai).toEqual({ type: "api_key", key: "sk-openai-from-other-instance" });
      // And the received provider was merged in alongside it — no full-snapshot clobber.
      expect(diskState.anthropic).toEqual({ type: "api_key", key: "sk-ant-mesh-received" });
      expect(mockMeshAuthStorageSet).toHaveBeenCalledTimes(1);
    });
  });
});

describe("/api/mesh/task-ids routes", () => {
  let app: ReturnType<typeof createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockGetLocalNode.mockResolvedValue({ id: "node_local", type: "local", name: "local", status: "online", maxConcurrent: 4, createdAt: "2026-04-01T10:00:00.000Z", updatedAt: "2026-04-01T12:00:00.000Z" });
    mockGetNode.mockResolvedValue(undefined);
    mockReserveDistributedTaskId.mockResolvedValue({ reservationId: "res-1", taskId: "FN-001", sequence: 1, expiresAt: "2030-01-01T00:00:00.000Z", committedClusterTaskCount: 0 });
    mockCommitDistributedTaskIdReservation.mockResolvedValue({ reservationId: "res-1", taskId: "FN-001", sequence: 1, committedClusterTaskCount: 1, committedAt: "2030-01-01T00:00:00.000Z" });
    mockAbortDistributedTaskIdReservation.mockResolvedValue({ reservationId: "res-1", taskId: "FN-001", sequence: 1, committedClusterTaskCount: 0, abortedAt: "2030-01-01T00:00:00.000Z" });
    mockGetDistributedTaskIdState.mockResolvedValue({ nextSequence: 2, committedClusterTaskCount: 1, activeReservationCount: 0, burnedReservationCount: 0, lastCommittedTaskId: "FN-001" });
    app = createMeshTestServer(new MockStore() as unknown as TaskStore);
  });

  it("reserves distributed task ids locally", async () => {
    const response = await request(app, "POST", "/api/mesh/task-ids/reserve", JSON.stringify({ prefix: "FN", nodeId: "node-a" }), { "Content-Type": "application/json" });
    expect(response.status).toBe(200);
    expect(mockReserveDistributedTaskId).toHaveBeenCalledWith({ prefix: "FN", nodeId: "node-a", ttlMs: undefined });
    expect((response.body as any).committedClusterTaskCount).toBe(0);
  });

  it("returns allocator state with authoritative committedClusterTaskCount", async () => {
    const response = await request(app, "GET", "/api/mesh/task-ids/state?prefix=FN");
    expect(response.status).toBe(200);
    expect((response.body as any).committedClusterTaskCount).toBe(1);
  });

  it("rejects bad requests", async () => {
    const response = await request(app, "POST", "/api/mesh/task-ids/abort", JSON.stringify({ reservationId: "r", nodeId: "n", reason: "bad" }), { "Content-Type": "application/json" });
    expect(response.status).toBe(400);
  });

  it("rejects unauthorized mesh caller", async () => {
    mockGetNode.mockResolvedValue(makeNodeConfig({ id: "node_remote_1", apiKey: "secret" }));
    const response = await request(
      app,
      "POST",
      "/api/mesh/task-ids/reserve",
      JSON.stringify({ prefix: "FN", nodeId: "node-a", senderNodeId: "node_remote_1" }),
      { "Content-Type": "application/json", Authorization: "Bearer wrong" },
    );
    expect(response.status).toBe(401);
  });

  it("ignores coordinatorNodeId and commits locally against shared allocator rows", async () => {
    // FNXC:SharedPostgresMultiNode 2026-07-14-23:45: remote coordinator hops are retired.
    mockCommitDistributedTaskIdReservation.mockResolvedValue({ reservationId: "res-1", taskId: "FN-001", status: "committed" });
    const response = await request(
      app,
      "POST",
      "/api/mesh/task-ids/commit",
      JSON.stringify({ reservationId: "res-1", nodeId: "node-a", coordinatorNodeId: "node_remote_1" }),
      { "Content-Type": "application/json" },
    );
    expect(response.status).toBe(200);
    expect(mockCommitDistributedTaskIdReservation).toHaveBeenCalledWith({ reservationId: "res-1", nodeId: "node-a" });
    expect(mockGetNode).not.toHaveBeenCalled();
  });
});



describe("GET /api/mesh/state", () => {
  let app: ReturnType<typeof createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockGetNode.mockResolvedValue(undefined);
    app = createMeshTestServer(new MockStore() as unknown as TaskStore);
  });

  it("returns local-only mesh snapshot when includeRemote=false", async () => {
    const response = await request(app, "GET", "/api/mesh/state?includeRemote=false");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      sourceNodeId: "node_local",
      nodes: [
        {
          nodeId: "node_local",
          nodeType: "local",
        },
      ],
    });
  });

  it("reuses provided centralCore instance", async () => {
    const sharedCentral = {
      isInitialized: vi.fn().mockReturnValue(true),
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getLocalMeshSnapshot: vi.fn().mockResolvedValue([{
        nodeId: "node_local",
        nodeName: "local",
        nodeUrl: undefined,
        nodeType: "local",
        status: "online",
        metrics: null,
        lastSeen: "2026-04-01T12:00:00.000Z",
        connectedAt: "2026-04-01T10:00:00.000Z",
        knownPeers: [],
      }]),
      getLocalNode: vi.fn().mockResolvedValue({ id: "node_local", type: "local" }),
      listNodes: vi.fn().mockResolvedValue([]),
    };

    const store = new MockStore();
    const sharedApp = createMeshTestServer(store as unknown as TaskStore, { centralCore: sharedCentral as never });
    const response = await request(sharedApp, "GET", "/api/mesh/state?includeRemote=false");

    expect(response.status).toBe(200);
    expect(sharedCentral.close).not.toHaveBeenCalled();
    expect(sharedCentral.getLocalMeshSnapshot).toHaveBeenCalledTimes(1);
  });

  it("merges remote mesh snapshots and deduplicates by nodeId", async () => {
    mockListNodes.mockResolvedValue([
      { id: "node_local", name: "local", type: "local", status: "online", maxConcurrent: 4, createdAt: "2026-04-01T10:00:00.000Z", updatedAt: "2026-04-01T12:00:00.000Z" },
      { id: "node_remote_1", name: "Remote 1", type: "remote", url: "https://remote-1.example.com", status: "online", maxConcurrent: 2, createdAt: "2026-04-01T10:00:00.000Z", updatedAt: "2026-04-01T12:00:00.000Z" },
    ]);

    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        sourceNodeId: "node_remote_1",
        collectedAt: "2026-04-01T12:00:00.000Z",
        nodes: [
          {
            nodeId: "node_remote_1",
            nodeName: "Remote 1",
            nodeUrl: "https://remote-1.example.com",
            nodeType: "remote",
            status: "online",
            metrics: null,
            lastSeen: "2026-04-01T12:00:00.000Z",
            connectedAt: "2026-04-01T10:00:00.000Z",
            knownPeers: [],
          },
          {
            nodeId: "node_local",
            nodeName: "local",
            nodeType: "local",
            status: "online",
            metrics: null,
            lastSeen: "2026-04-01T12:00:00.000Z",
            connectedAt: "2026-04-01T10:00:00.000Z",
            knownPeers: [],
          },
        ],
      }),
    } as Response);

    const response = await request(app, "GET", "/api/mesh/state");
    fetchSpy.mockRestore();

    expect(response.status).toBe(200);
    expect((response.body as { nodes: Array<{ nodeId: string }> }).nodes.map((node) => node.nodeId).sort()).toEqual([
      "node_local",
      "node_remote_1",
    ]);
  });

  it("keeps local fallback snapshots when remote fetch fails", async () => {
    mockListNodes.mockResolvedValue([
      { id: "node_local", name: "local", type: "local", status: "online", maxConcurrent: 4, createdAt: "2026-04-01T10:00:00.000Z", updatedAt: "2026-04-01T12:00:00.000Z" },
      { id: "node_remote_1", name: "Remote 1", type: "remote", url: "https://remote-1.example.com", status: "online", maxConcurrent: 2, createdAt: "2026-04-01T10:00:00.000Z", updatedAt: "2026-04-01T12:00:00.000Z" },
    ]);
    vi.spyOn(globalThis, "fetch" as any).mockRejectedValue(new Error("offline"));

    const response = await request(app, "GET", "/api/mesh/state");

    vi.restoreAllMocks();
    expect(response.status).toBe(200);
    expect((response.body as { nodes: Array<{ nodeId: string }> }).nodes.map((node) => node.nodeId)).toContain("node_local");
  });
});

/*
FNXC:PostgresCutover 2026-07-12:
Task mesh replication is REMOVED on the PostgreSQL backend — nodes share the
database, so replication is handled at the PostgreSQL level. These tests pin
the three gates: replicated task creates 409 (stable code), inbound/outbound
/mesh/sync shared-state is reduced to authMaterial only (the one domain not in
the database), and task-ID reservations never forward to a remote coordinator
(the shared distributed_task_id_state rows ARE the coordinator).
*/
describe("PostgreSQL backend mode: task mesh replication disabled", () => {
  class BackendModeMockStore extends MockStore {
    override get backendMode(): boolean {
      return true;
    }

  }

  let app: ReturnType<typeof createServer>;
  let store: BackendModeMockStore;

  beforeEach(() => {
    vi.clearAllMocks();
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
    mockReserveDistributedTaskId.mockResolvedValue({ reservationId: "res-1", taskId: "FN-001", sequence: 1, expiresAt: "2030-01-01T00:00:00.000Z", committedClusterTaskCount: 0 });
    store = new BackendModeMockStore();
    app = createMeshTestServer(store as unknown as TaskStore);
  });

  it("POST /api/mesh/tasks/create no longer exists (route removed — replication is the database)", async () => {
    const response = await request(
      app,
      "POST",
      "/api/mesh/tasks/create",
      JSON.stringify({
        replicationVersion: 1,
        reservationId: "res-9",
        taskId: "FN-900",
        sourceNodeId: "node_remote",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
        prompt: "# FN-900",
        input: { description: "replicated" },
      }),
      { "Content-Type": "application/json" }
    );

    expect(response.status).toBe(404);
    expect(mockApplyReplicatedTaskCreate).not.toHaveBeenCalled();
  });

  it("POST /api/mesh/sync ignores inbound task-state domains and offers no database-backed snapshots", async () => {
    const response = await request(
      app,
      "POST",
      "/api/mesh/sync",
      JSON.stringify({
        senderNodeId: "node_remote",
        knownPeers: [],
        sharedState: {
          taskMetadata: { domain: "task-metadata", version: 1, entries: [] },
        },
      }),
      { "Content-Type": "application/json" }
    );

    expect(response.status).toBe(200);
    // Peer topology exchange still works (discovery is not replication).
    expect(mockMergePeers).toHaveBeenCalled();
    // No database-backed domains are offered back to the peer.
    const shared = (response.body as { sharedState?: Record<string, unknown> }).sharedState ?? {};
    for (const domain of ["taskMetadata", "missionHierarchy", "agents", "agentRuns", "activityLog", "runAudit", "projectSettings"]) {
      expect(shared[domain]).toBeUndefined();
    }
  });

  it("POST /api/mesh/task-ids/reserve resolves locally even when a remote coordinator is named", async () => {
    const response = await request(
      app,
      "POST",
      "/api/mesh/task-ids/reserve",
      JSON.stringify({ prefix: "FN", nodeId: "node_remote", coordinatorNodeId: "node_other_coordinator" }),
      { "Content-Type": "application/json" }
    );

    expect(response.status).toBe(200);
    // The shared-database allocator handled it; no coordinator lookup/forward.
    expect(mockReserveDistributedTaskId).toHaveBeenCalledWith({ prefix: "FN", nodeId: "node_remote", ttlMs: undefined });
    expect(mockGetNode).not.toHaveBeenCalled();
  });
});
