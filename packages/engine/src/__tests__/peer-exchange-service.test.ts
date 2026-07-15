import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CentralCore, NodeConfig, PeerInfo, SettingsSyncPayload } from "@fusion/core";
import { PeerExchangeService } from "../peer-exchange-service.js";

function makeNode(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id: "node_remote",
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

function makePeerInfo(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    nodeId: "node_peer",
    nodeName: "Peer Node",
    nodeUrl: "https://peer.example.com",
    status: "online",
    metrics: null,
    lastSeen: "2026-04-01T12:00:00.000Z",
    maxConcurrent: 2,
    ...overrides,
  };
}

function makeSettingsPayload(overrides: Partial<SettingsSyncPayload> = {}): SettingsSyncPayload {
  return {
    exportedAt: "2026-04-01T00:00:00.000Z",
    checksum: "abc123def456",
    version: 1,
    global: {},
    ...overrides,
  };
}

describe("PeerExchangeService", () => {
  let mockCentralCore: CentralCore;
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockListNodes: ReturnType<typeof vi.fn>;
  let mockGetAllKnownPeerInfo: ReturnType<typeof vi.fn>;
  let mockMergePeers: ReturnType<typeof vi.fn>;
  let mockReportMeshState: ReturnType<typeof vi.fn>;
  let mockGetSettingsForSync: ReturnType<typeof vi.fn>;
  let mockApplyRemoteSettings: ReturnType<typeof vi.fn>;
  let mockGetProjectSettingsSnapshot: ReturnType<typeof vi.fn>;
  let mockGetAuthMaterialSnapshot: ReturnType<typeof vi.fn>;
  let mockApplyProjectSettingsSnapshot: ReturnType<typeof vi.fn>;
  let mockEnqueueMeshWrite: ReturnType<typeof vi.fn>;
  let mockListPendingMeshWrites: ReturnType<typeof vi.fn>;
  let mockMarkMeshWriteReplayStarted: ReturnType<typeof vi.fn>;
  let mockMarkMeshWriteApplied: ReturnType<typeof vi.fn>;
  let mockMarkMeshWriteFailed: ReturnType<typeof vi.fn>;
  let mockGetNode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));

    // Create individual mocks
    mockListNodes = vi.fn();
    mockGetAllKnownPeerInfo = vi.fn();
    mockMergePeers = vi.fn();
    mockReportMeshState = vi.fn();
    mockGetSettingsForSync = vi.fn();
    mockApplyRemoteSettings = vi.fn();
    mockGetProjectSettingsSnapshot = vi.fn();
    mockGetAuthMaterialSnapshot = vi.fn();
    mockApplyProjectSettingsSnapshot = vi.fn();
    mockEnqueueMeshWrite = vi.fn();
    mockListPendingMeshWrites = vi.fn();
    mockMarkMeshWriteReplayStarted = vi.fn();
    mockMarkMeshWriteApplied = vi.fn();
    mockMarkMeshWriteFailed = vi.fn();
    mockGetNode = vi.fn();

    mockCentralCore = {
      // Default: not shared-Postgres backendMode so legacy settings-sync tests remain valid.
      backendMode: false,
      listNodes: mockListNodes,
      getAllKnownPeerInfo: mockGetAllKnownPeerInfo,
      mergePeers: mockMergePeers,
      reportMeshState: mockReportMeshState,
      getSettingsForSync: mockGetSettingsForSync,
      applyRemoteSettings: mockApplyRemoteSettings,
      getProjectSettingsSnapshot: mockGetProjectSettingsSnapshot,
      getAuthMaterialSnapshot: mockGetAuthMaterialSnapshot,
      applyProjectSettingsSnapshot: mockApplyProjectSettingsSnapshot,
      enqueueMeshWrite: mockEnqueueMeshWrite,
      listPendingMeshWrites: mockListPendingMeshWrites,
      markMeshWriteReplayStarted: mockMarkMeshWriteReplayStarted,
      markMeshWriteApplied: mockMarkMeshWriteApplied,
      markMeshWriteFailed: mockMarkMeshWriteFailed,
      getNode: mockGetNode,
    } as unknown as CentralCore;

    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    mockListPendingMeshWrites.mockResolvedValue([]);
    mockGetNode.mockResolvedValue(makeNode());
    mockEnqueueMeshWrite.mockResolvedValue({ id: "mq-1" });
    mockMarkMeshWriteReplayStarted.mockResolvedValue(undefined);
    mockMarkMeshWriteApplied.mockResolvedValue(undefined);
    mockMarkMeshWriteFailed.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setupSuccessfulSync(node: NodeConfig = makeNode()) {
    mockListNodes.mockResolvedValue([
      makeNode({ id: "node_local", type: "local", status: "online" }),
    ]);
    mockGetAllKnownPeerInfo.mockResolvedValue([makePeerInfo({ nodeId: "node_local", nodeName: "local" })]);
    mockMergePeers.mockResolvedValue({ added: [], updated: [] });
    mockReportMeshState.mockResolvedValue({});
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        senderNodeId: node.id,
        senderNodeUrl: node.url,
        knownPeers: [],
        newPeers: [],
        timestamp: "2026-04-01T12:00:00.000Z",
      }),
    });
  }

  describe("constructor", () => {
    it("should create service instance", () => {
      const service = new PeerExchangeService(mockCentralCore);
      expect(service).toBeDefined();
    });

    it("should accept custom sync interval", () => {
      const service = new PeerExchangeService(mockCentralCore, { syncIntervalMs: 30_000 });
      expect(service).toBeDefined();
    });

    it("should use default sync interval of 120 seconds", () => {
      mockListNodes.mockResolvedValue([]);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const service = new PeerExchangeService(mockCentralCore);

      service.start();

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);
      service.stop();
    });

    it("should default settingsSyncEnabled to false", async () => {
      const service = new PeerExchangeService(mockCentralCore);
      setupSuccessfulSync();
      await service.syncWithNode(makeNode());
      expect(mockGetSettingsForSync).not.toHaveBeenCalled();
    });

    it("should accept settingsSyncEnabled option", async () => {
      mockGetSettingsForSync.mockResolvedValue(makeSettingsPayload());
      const service = new PeerExchangeService(mockCentralCore, { settingsSyncEnabled: true });
      setupSuccessfulSync();
      await service.syncWithNode(makeNode());
      expect(mockGetSettingsForSync).toHaveBeenCalled();
    });

    it("should default settingsSyncThrottleMs to 300000 (5 minutes)", async () => {
      mockGetSettingsForSync.mockResolvedValue(makeSettingsPayload());
      const service = new PeerExchangeService(mockCentralCore, { settingsSyncEnabled: true });
      setupSuccessfulSync();

      // First sync - should include settings
      await service.syncWithNode(makeNode());
      expect(mockGetSettingsForSync).toHaveBeenCalledTimes(1);

      // Advance time by 1 minute (less than 5 minute throttle)
      vi.advanceTimersByTime(60_000);

      // Second sync - should be throttled (getSettingsForSync not called again)
      await service.syncWithNode(makeNode());
      expect(mockGetSettingsForSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("syncWithNode()", () => {
    it("should send correct request body with auth header when apiKey is set", async () => {
      const node = makeNode({ apiKey: "secret-key" });
      mockListNodes.mockResolvedValue([
        makeNode({ id: "node_local", type: "local", status: "online" }),
      ]);
      mockGetAllKnownPeerInfo.mockResolvedValue([
        makePeerInfo({ nodeId: "node_local", nodeName: "local" }),
        makePeerInfo({ nodeId: "node_remote" }),
      ]);
      mockMergePeers.mockResolvedValue({ added: [], updated: [] });
      mockReportMeshState.mockResolvedValue({});
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          newPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
        }),
      });

      const service = new PeerExchangeService(mockCentralCore);
      const result = await service.syncWithNode(node);

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://remote.example.com/api/mesh/sync",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer secret-key",
          },
          body: expect.stringContaining('"senderNodeId":"node_local"'),
        })
      );
    });

    it("should send request without auth header when no apiKey", async () => {
      const node = makeNode({ apiKey: undefined });
      mockListNodes.mockResolvedValue([
        makeNode({ id: "node_local", type: "local", status: "online" }),
      ]);
      mockGetAllKnownPeerInfo.mockResolvedValue([]);
      mockMergePeers.mockResolvedValue({ added: [], updated: [] });
      mockReportMeshState.mockResolvedValue({});
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          newPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
        }),
      });

      const service = new PeerExchangeService(mockCentralCore);
      await service.syncWithNode(node);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.not.objectContaining({ "Authorization": expect.anything() }),
        })
      );
    });

    it("should merge response.knownPeers (not just newPeers)", async () => {
      const node = makeNode();
      mockListNodes.mockResolvedValue([
        makeNode({ id: "node_local", type: "local", status: "online" }),
      ]);

      const allPeersFromResponse = [
        makePeerInfo({ nodeId: "node_local", nodeName: "local", status: "online" }),
        makePeerInfo({ nodeId: "node_peer_a", status: "online" }),
        makePeerInfo({ nodeId: "node_peer_b", status: "offline" }),
      ];

      mockGetAllKnownPeerInfo.mockResolvedValue([
        makePeerInfo({ nodeId: "node_local", nodeName: "local" }),
      ]);
      mockMergePeers.mockResolvedValue({ added: ["node_peer_a"], updated: ["node_peer_b"] });
      mockReportMeshState.mockResolvedValue({});
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: allPeersFromResponse,
          newPeers: [makePeerInfo({ nodeId: "node_peer_c" })],
          timestamp: "2026-04-01T12:00:00.000Z",
        }),
      });

      const service = new PeerExchangeService(mockCentralCore);
      const result = await service.syncWithNode(node);

      expect(result.success).toBe(true);
      // Verify merge was called with all knownPeers, not just newPeers
      expect(mockMergePeers).toHaveBeenCalledWith(allPeersFromResponse);
    });

    it("should refresh local metrics before sending request", async () => {
      const node = makeNode();
      mockListNodes.mockResolvedValue([
        makeNode({ id: "node_local", type: "local", status: "online" }),
      ]);
      mockGetAllKnownPeerInfo.mockResolvedValue([]);
      mockMergePeers.mockResolvedValue({ added: [], updated: [] });
      mockReportMeshState.mockResolvedValue({});
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          newPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
        }),
      });

      const service = new PeerExchangeService(mockCentralCore);
      await service.syncWithNode(node);

      expect(mockReportMeshState).toHaveBeenCalled();
    });

    it("should handle network error gracefully", async () => {
      const node = makeNode();
      mockListNodes.mockResolvedValue([
        makeNode({ id: "node_local", type: "local", status: "online" }),
      ]);
      mockGetAllKnownPeerInfo.mockResolvedValue([]);
      mockReportMeshState.mockResolvedValue({});
      mockFetch.mockRejectedValue(new Error("Network error"));

      const service = new PeerExchangeService(mockCentralCore);
      const result = await service.syncWithNode(node);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Network error");
    });

    it("should handle non-2xx response", async () => {
      const node = makeNode();
      mockListNodes.mockResolvedValue([
        makeNode({ id: "node_local", type: "local", status: "online" }),
      ]);
      mockGetAllKnownPeerInfo.mockResolvedValue([]);
      mockReportMeshState.mockResolvedValue({});
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      const service = new PeerExchangeService(mockCentralCore);
      const result = await service.syncWithNode(node);

      expect(result.success).toBe(false);
      expect(result.error).toContain("HTTP 401");
      expect(mockEnqueueMeshWrite).not.toHaveBeenCalled();
    });

    it("queues retryable failures and returns queued write id", async () => {
      const node = makeNode();
      mockListNodes.mockResolvedValue([makeNode({ id: "node_local", type: "local", status: "online" })]);
      mockGetAllKnownPeerInfo.mockResolvedValue([]);
      mockReportMeshState.mockResolvedValue({});
      mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" });
      mockEnqueueMeshWrite.mockResolvedValue({ id: "mq-queued-1" });

      const service = new PeerExchangeService(mockCentralCore);
      const result = await service.syncWithNode(node);

      expect(result.success).toBe(false);
      expect(result.queuedWriteId).toBe("mq-queued-1");
      expect(mockEnqueueMeshWrite).toHaveBeenCalledTimes(1);
    });

    it("reports replay summary after successful sync", async () => {
      const node = makeNode();
      setupSuccessfulSync(node);
      mockListPendingMeshWrites.mockResolvedValue([
        {
          id: "mq-1",
          originNodeId: "node_local",
          targetNodeId: node.id,
          projectId: null,
          scope: "mesh.sync",
          entityType: "shared-state-sync",
          entityId: node.id,
          operation: "sync",
          payload: { request: { senderNodeId: "node_local", knownPeers: [], senderNodeUrl: "", timestamp: "2026-04-01T12:00:00.000Z" } },
          intentVersion: "1.0",
          status: "pending",
          attemptCount: 0,
          createdAt: "2026-04-01T12:00:00.000Z",
          updatedAt: "2026-04-01T12:00:00.000Z",
        },
      ]);

      const service = new PeerExchangeService(mockCentralCore);
      const result = await service.syncWithNode(node);

      expect(result.replaySummary).toEqual({ replayed: 1, applied: 1, failed: 0, queuedWriteIds: ["mq-1"] });
      expect(mockMarkMeshWriteReplayStarted).toHaveBeenCalledWith("mq-1");
      expect(mockMarkMeshWriteApplied).toHaveBeenCalledWith("mq-1", {});
    });
  });

  /*
  FNXC:SharedPostgresMultiNode 2026-07-14-23:45:
  Under shared Postgres, settings gossip is forced off, queue rows are
  topology/auth-scoped, and non-topology pending writes are failed rather than
  replayed as multi-leader task/settings payloads.
  */
  describe("shared PostgreSQL backendMode", () => {
    beforeEach(() => {
      Object.defineProperty(mockCentralCore, "backendMode", { value: true, configurable: true });
    });

    it("force-disables settingsSyncEnabled even when the option is true", async () => {
      mockGetSettingsForSync.mockResolvedValue(makeSettingsPayload());
      const service = new PeerExchangeService(mockCentralCore, { settingsSyncEnabled: true });
      setupSuccessfulSync();
      await service.syncWithNode(makeNode());
      expect(mockGetSettingsForSync).not.toHaveBeenCalled();
    });

    it("enqueues retryable peer failures as mesh.topology / topology-sync", async () => {
      const node = makeNode();
      mockListNodes.mockResolvedValue([makeNode({ id: "node_local", type: "local", status: "online" })]);
      mockGetAllKnownPeerInfo.mockResolvedValue([]);
      mockReportMeshState.mockResolvedValue({});
      mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" });
      mockEnqueueMeshWrite.mockResolvedValue({ id: "mq-topo-1" });

      const service = new PeerExchangeService(mockCentralCore);
      const result = await service.syncWithNode(node);

      expect(result.queuedWriteId).toBe("mq-topo-1");
      expect(mockEnqueueMeshWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "mesh.topology",
          entityType: "topology-sync",
        }),
      );
      const payload = mockEnqueueMeshWrite.mock.calls[0][0].payload.request;
      expect(payload.settings).toBeUndefined();
      expect(payload.sharedState?.projectSettings).toBeUndefined();
    });

    it("replays topology scopes and fails retired task/settings queue rows", async () => {
      const node = makeNode();
      setupSuccessfulSync(node);
      mockListPendingMeshWrites.mockResolvedValue([
        {
          id: "mq-topo",
          originNodeId: "node_local",
          targetNodeId: node.id,
          projectId: null,
          scope: "mesh.topology",
          entityType: "topology-sync",
          entityId: node.id,
          operation: "sync",
          payload: { request: { senderNodeId: "node_local", knownPeers: [], senderNodeUrl: "", timestamp: "2026-04-01T12:00:00.000Z" } },
          intentVersion: "1.0",
          status: "pending",
          attemptCount: 0,
          createdAt: "2026-04-01T12:00:00.000Z",
          updatedAt: "2026-04-01T12:00:00.000Z",
        },
        {
          id: "mq-task",
          originNodeId: "node_local",
          targetNodeId: node.id,
          projectId: "proj-1",
          scope: "task.strong",
          entityType: "task-create",
          entityId: "FN-1",
          operation: "create",
          payload: { request: {} },
          intentVersion: "1.0",
          status: "pending",
          attemptCount: 0,
          createdAt: "2026-04-01T12:00:00.000Z",
          updatedAt: "2026-04-01T12:00:00.000Z",
        },
      ]);

      const service = new PeerExchangeService(mockCentralCore);
      const result = await service.syncWithNode(node);

      expect(result.replaySummary).toEqual({
        replayed: 1,
        applied: 1,
        failed: 0,
        queuedWriteIds: ["mq-topo"],
      });
      expect(mockMarkMeshWriteFailed).toHaveBeenCalledWith(
        "mq-task",
        expect.objectContaining({ lastError: expect.stringContaining("retired") }),
      );
      expect(mockMarkMeshWriteReplayStarted).toHaveBeenCalledWith("mq-topo");
      expect(mockMarkMeshWriteApplied).toHaveBeenCalledWith("mq-topo", {});
    });
  });

  describe("triggerSync()", () => {
    it("should trigger sync when called", async () => {
      mockListNodes.mockResolvedValue([
        makeNode({ id: "node_local", type: "local", status: "online" }),
        makeNode({ id: "node_1", name: "Remote 1", status: "online", url: "https://remote1.example.com" }),
      ]);
      mockGetAllKnownPeerInfo.mockResolvedValue([]);
      mockMergePeers.mockResolvedValue({ added: [], updated: [] });
      mockReportMeshState.mockResolvedValue({});
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_1",
          senderNodeUrl: "https://remote1.example.com",
          knownPeers: [],
          newPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
        }),
      });

      const service = new PeerExchangeService(mockCentralCore, { syncIntervalMs: 60_000 });
      const results = await service.triggerSync();

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe("settings sync - when disabled", () => {
    it("should NOT call getSettingsForSync", async () => {
      const service = new PeerExchangeService(mockCentralCore);
      setupSuccessfulSync();
      await service.syncWithNode(makeNode());
      expect(mockGetSettingsForSync).not.toHaveBeenCalled();
    });

    it("should NOT include settings in request body", async () => {
      const service = new PeerExchangeService(mockCentralCore);
      setupSuccessfulSync();
      await service.syncWithNode(makeNode());
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.settings).toBeUndefined();
    });

    it("should NOT have settingsApplied or settingsVersion in result", async () => {
      const service = new PeerExchangeService(mockCentralCore);
      setupSuccessfulSync();
      const result = await service.syncWithNode(makeNode());
      expect(result.settingsApplied).toBeUndefined();
      expect(result.settingsVersion).toBeUndefined();
    });
  });

  describe("settings sync - when enabled", () => {
    it("should call getSettingsForSync and include settings in request", async () => {
      const service = new PeerExchangeService(mockCentralCore, { settingsSyncEnabled: true });
      const payload = makeSettingsPayload({ checksum: "local-checksum-123" });
      mockGetSettingsForSync.mockResolvedValue(payload);
      mockGetProjectSettingsSnapshot.mockResolvedValue({ version: 1, exportedAt: payload.exportedAt, checksum: payload.checksum, payload: { global: {} } });
      mockGetAuthMaterialSnapshot.mockReturnValue({ version: 1, exportedAt: payload.exportedAt, checksum: "auth-checksum", payload: { providerAuth: {} } });
      setupSuccessfulSync();

      await service.syncWithNode(makeNode());

      expect(mockGetSettingsForSync).toHaveBeenCalled();
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.settings).toBeDefined();
      expect(body.settings.checksum).toBe("local-checksum-123");
      expect(body.sharedState?.projectSettings?.checksum).toBe("local-checksum-123");
    });

    it("should include settings on first sync with a node (no throttle entry)", async () => {
      const service = new PeerExchangeService(mockCentralCore, { settingsSyncEnabled: true });
      const payload = makeSettingsPayload({ checksum: "first-sync-checksum" });
      mockGetSettingsForSync.mockResolvedValue(payload);
      setupSuccessfulSync();

      await service.syncWithNode(makeNode());

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.settings).toBeDefined();
      expect(body.settings.checksum).toBe("first-sync-checksum");
    });

    it("should NOT include settings when within throttle window and checksum unchanged", async () => {
      const service = new PeerExchangeService(mockCentralCore, {
        settingsSyncEnabled: true,
        settingsSyncThrottleMs: 300_000, // 5 minutes
      });
      // Use same checksum for local and remote so settings won't be applied (checksums match)
      const localPayload = makeSettingsPayload({ checksum: "same-checksum" });
      const remotePayload = makeSettingsPayload({ checksum: "same-checksum" });
      mockGetSettingsForSync.mockResolvedValue(localPayload);
      mockApplyRemoteSettings.mockResolvedValue({ success: true, globalCount: 1, projectCount: 0, authCount: 0 });
      setupSuccessfulSync();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          newPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
          settings: remotePayload,
        }),
      });

      // First sync
      await service.syncWithNode(makeNode());
      expect(mockGetSettingsForSync).toHaveBeenCalledTimes(1);

      // Advance time by 1 minute (within throttle window)
      vi.advanceTimersByTime(60_000);

      // Second sync should be throttled - cache is used, getSettingsForSync NOT called
      await service.syncWithNode(makeNode());

      // getSettingsForSync should NOT be called again because cache is populated
      expect(mockGetSettingsForSync).toHaveBeenCalledTimes(1);

      // Settings should NOT be in the request because within throttle window
      const call = mockFetch.mock.calls[1];
      const body = JSON.parse(call[1].body);
      expect(body.settings).toBeUndefined();
    });

    it("should include settings when throttle window expires", async () => {
      const service = new PeerExchangeService(mockCentralCore, {
        settingsSyncEnabled: true,
        settingsSyncThrottleMs: 300_000, // 5 minutes
      });
      const localPayload = makeSettingsPayload({ checksum: "stable-checksum" });
      mockGetSettingsForSync.mockResolvedValue(localPayload);
      mockApplyRemoteSettings.mockResolvedValue({ success: true, globalCount: 1, projectCount: 0, authCount: 0 });
      setupSuccessfulSync();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          newPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
          settings: localPayload,
        }),
      });

      // First sync
      await service.syncWithNode(makeNode());
      expect(mockGetSettingsForSync).toHaveBeenCalledTimes(1);

      // Advance time by 6 minutes (past throttle window)
      vi.advanceTimersByTime(6 * 60_000);

      // Second sync should include settings (throttle expired) - cache is still used
      await service.syncWithNode(makeNode());

      // getSettingsForSync should NOT be called again because cache is populated
      expect(mockGetSettingsForSync).toHaveBeenCalledTimes(1);

      // But settings SHOULD be in the request because throttle expired
      const call = mockFetch.mock.calls[1];
      const body = JSON.parse(call[1].body);
      expect(body.settings).toBeDefined();
    });

    it("should bypass throttle when local checksum changes via updateGlobalSettings", async () => {
      const service = new PeerExchangeService(mockCentralCore, {
        settingsSyncEnabled: true,
        settingsSyncThrottleMs: 300_000, // 5 minutes
      });
      const payload1 = makeSettingsPayload({ checksum: "old-checksum" });
      const payload2 = makeSettingsPayload({ checksum: "new-checksum" });
      mockGetSettingsForSync.mockResolvedValue(payload1);
      setupSuccessfulSync();

      // First sync with old checksum
      await service.syncWithNode(makeNode());
      expect(mockGetSettingsForSync).toHaveBeenCalledTimes(1);

      // Advance time by 1 minute (within throttle window)
      vi.advanceTimersByTime(60_000);

      // Manually invalidate cache to simulate settings change
      service.updateGlobalSettings({});

      // Mock should return new payload for next call
      mockGetSettingsForSync.mockResolvedValue(payload2);

      // Second sync should include settings (version changed bypasses throttle)
      await service.syncWithNode(makeNode());

      // getSettingsForSync SHOULD be called because cache was invalidated
      expect(mockGetSettingsForSync).toHaveBeenCalledTimes(2);

      const call = mockFetch.mock.calls[1];
      const body = JSON.parse(call[1].body);
      expect(body.settings).toBeDefined();
      expect(body.settings.checksum).toBe("new-checksum");
    });
  });

  describe("settings sync - applying remote settings", () => {
    it("should apply remote settings when remote checksum differs", async () => {
      const service = new PeerExchangeService(mockCentralCore, { settingsSyncEnabled: true });
      const localPayload = makeSettingsPayload({ checksum: "local-checksum" });
      const remotePayload = makeSettingsPayload({ checksum: "remote-checksum" });
      mockGetSettingsForSync.mockResolvedValue(localPayload);
      mockApplyProjectSettingsSnapshot.mockResolvedValue({
        success: true,
        globalCount: 5,
        projectCount: 2,
        authCount: 1,
      });
      setupSuccessfulSync();

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          newPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
          sharedState: {
            projectSettings: remotePayload,
            authMaterial: { ...remotePayload, payload: { providerAuth: {} } },
          },
        }),
      });

      const result = await service.syncWithNode(makeNode());

      expect(mockApplyProjectSettingsSnapshot).toHaveBeenCalledWith(remotePayload);
      expect(result.settingsApplied).toBe(true);
      expect(result.settingsVersion).toBe("remote-checksum");
    });

    it("should NOT apply remote settings when checksums match", async () => {
      const service = new PeerExchangeService(mockCentralCore, { settingsSyncEnabled: true });
      const samePayload = makeSettingsPayload({ checksum: "same-checksum" });
      mockGetSettingsForSync.mockResolvedValue(samePayload);
      setupSuccessfulSync();

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          newPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
          settings: samePayload,
        }),
      });

      const result = await service.syncWithNode(makeNode());

      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
      expect(result.settingsApplied).toBe(false);
    });

    it("should apply remote settings when local cache is null (first sync)", async () => {
      const service = new PeerExchangeService(mockCentralCore, { settingsSyncEnabled: true });
      const remotePayload = makeSettingsPayload({ checksum: "remote-only-checksum" });
      mockGetSettingsForSync.mockResolvedValue(makeSettingsPayload({ checksum: "local-checksum" }));
      mockApplyRemoteSettings.mockResolvedValue({
        success: true,
        globalCount: 3,
        projectCount: 1,
        authCount: 0,
      });
      setupSuccessfulSync();

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          newPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
          settings: remotePayload,
        }),
      });

      const result = await service.syncWithNode(makeNode());

      expect(mockApplyRemoteSettings).toHaveBeenCalled();
      expect(result.settingsApplied).toBe(true);
    });

    it("should update throttle tracking after receiving settings", async () => {
      const service = new PeerExchangeService(mockCentralCore, {
        settingsSyncEnabled: true,
        settingsSyncThrottleMs: 300_000,
      });
      // Use same checksum so settings are NOT applied (but throttle tracking is updated)
      const payload = makeSettingsPayload({ checksum: "same-checksum" });
      mockGetSettingsForSync.mockResolvedValue(payload);
      mockApplyRemoteSettings.mockResolvedValue({ success: true, globalCount: 1, projectCount: 0, authCount: 0 });
      setupSuccessfulSync();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          newPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
          settings: payload,
        }),
      });

      // First sync
      await service.syncWithNode(makeNode());
      expect(mockGetSettingsForSync).toHaveBeenCalledTimes(1);

      // Advance time by 1 minute
      vi.advanceTimersByTime(60_000);

      // Second sync should be throttled - cache exists and within window
      await service.syncWithNode(makeNode());

      // getSettingsForSync should NOT be called because cache is populated
      // and within throttle window
      expect(mockGetSettingsForSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("settings sync - error resilience", () => {
    it("should continue peer sync when getSettingsForSync throws", async () => {
      const service = new PeerExchangeService(mockCentralCore, { settingsSyncEnabled: true });
      mockGetSettingsForSync.mockRejectedValue(new Error("Settings unavailable"));
      setupSuccessfulSync();

      const result = await service.syncWithNode(makeNode());

      // Peer sync should still succeed
      expect(result.success).toBe(true);
      // settingsApplied should be false since settings sync failed
      expect(result.settingsApplied).toBe(false);
    });

    it("should continue peer sync when applyRemoteSettings throws", async () => {
      const service = new PeerExchangeService(mockCentralCore, { settingsSyncEnabled: true });
      const localPayload = makeSettingsPayload({ checksum: "local" });
      const remotePayload = makeSettingsPayload({ checksum: "remote" });
      mockGetSettingsForSync.mockResolvedValue(localPayload);
      mockApplyRemoteSettings.mockRejectedValue(new Error("Failed to apply settings"));
      setupSuccessfulSync();

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          newPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
          settings: remotePayload,
        }),
      });

      const result = await service.syncWithNode(makeNode());

      // Peer sync should still succeed even though settings apply failed
      expect(result.success).toBe(true);
      expect(result.settingsApplied).toBe(false);
    });

    it("should continue peer sync when applyRemoteSettings returns error result", async () => {
      const service = new PeerExchangeService(mockCentralCore, { settingsSyncEnabled: true });
      const localPayload = makeSettingsPayload({ checksum: "local" });
      const remotePayload = makeSettingsPayload({ checksum: "remote" });
      mockGetSettingsForSync.mockResolvedValue(localPayload);
      mockApplyRemoteSettings.mockResolvedValue({
        success: false,
        globalCount: 0,
        projectCount: 0,
        authCount: 0,
        error: "Checksum mismatch",
      });
      setupSuccessfulSync();

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          senderNodeId: "node_remote",
          senderNodeUrl: "https://remote.example.com",
          knownPeers: [],
          newPeers: [],
          timestamp: "2026-04-01T12:00:00.000Z",
          settings: remotePayload,
        }),
      });

      const result = await service.syncWithNode(makeNode());

      // Peer sync should still succeed
      expect(result.success).toBe(true);
      expect(result.settingsApplied).toBe(false);
    });
  });

  describe("updateGlobalSettings", () => {
    it("should invalidate cached settings payload", async () => {
      const service = new PeerExchangeService(mockCentralCore, { settingsSyncEnabled: true });
      const oldPayload = makeSettingsPayload({ checksum: "old-checksum" });
      const newPayload = makeSettingsPayload({ checksum: "new-checksum" });
      mockGetSettingsForSync.mockResolvedValue(oldPayload);
      setupSuccessfulSync();

      // First sync
      await service.syncWithNode(makeNode());
      expect(mockGetSettingsForSync).toHaveBeenCalledTimes(1);

      // Update global settings - invalidates cache
      service.updateGlobalSettings({});

      // Advance time within throttle window
      vi.advanceTimersByTime(60_000);

      // Mock should return new payload for next call
      mockGetSettingsForSync.mockResolvedValue(newPayload);

      // Second sync should fetch fresh settings (cache invalidated)
      await service.syncWithNode(makeNode());

      expect(mockGetSettingsForSync).toHaveBeenCalledTimes(2);
      const call = mockFetch.mock.calls[1];
      const body = JSON.parse(call[1].body);
      expect(body.settings.checksum).toBe("new-checksum");
    });
  });
});
