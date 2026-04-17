import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request, get } from "../test-request.js";

// Mock node:fs for auth.json reading
vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn().mockReturnValue(JSON.stringify({
      anthropic: { type: "api_key", key: "sk-ant-test123" },
      openai: { type: "api_key", key: "sk-test456" },
    })),
    existsSync: vi.fn().mockReturnValue(true),
  },
  readFileSync: vi.fn().mockReturnValue(JSON.stringify({
    anthropic: { type: "api_key", key: "sk-ant-test123" },
    openai: { type: "api_key", key: "sk-test456" },
  })),
  existsSync: vi.fn().mockReturnValue(true),
}));

// ── Mock @fusion/core for node routes ─────────────────────────────────

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListNodes = vi.fn();
const mockGetNode = vi.fn();
const mockGetLocalPeerInfo = vi.fn();
const mockGetSettingsSyncState = vi.fn();
const mockUpdateSettingsSyncState = vi.fn();
const mockApplyRemoteSettings = vi.fn();
const mockGetSettingsForSync = vi.fn();
const mockChatStoreInit = vi.fn().mockResolvedValue(undefined);
const mockAgentStoreInit = vi.fn().mockResolvedValue(undefined);
const mockAgentStoreGetAgent = vi.fn().mockResolvedValue(null);

vi.mock("@fusion/core", () => {
  return {
    CentralCore: class MockCentralCore {
      init = mockInit;
      close = mockClose;
      listNodes = mockListNodes;
      getNode = mockGetNode;
      getLocalPeerInfo = mockGetLocalPeerInfo;
      getSettingsSyncState = mockGetSettingsSyncState;
      updateSettingsSyncState = mockUpdateSettingsSyncState;
      applyRemoteSettings = mockApplyRemoteSettings;
      getSettingsForSync = mockGetSettingsForSync;
    },
    ChatStore: class MockChatStore {
      init = mockChatStoreInit;
    },
    AgentStore: class MockAgentStore {
      init = mockAgentStoreInit;
      getAgent = mockAgentStoreGetAgent;
    },
  };
});

// ── Mock AuthStorage ───────────────────────────────────────────────────

const mockAuthStorageSet = vi.fn();
const mockAuthStorageGetOAuthProviders = vi.fn().mockReturnValue([]);

vi.mock("@mariozechner/pi-coding-agent", () => {
  return {
    AuthStorage: {
      create: vi.fn(() => ({
        set: mockAuthStorageSet,
        get: vi.fn(),
        getApiKey: vi.fn(),
        getOAuthProviders: mockAuthStorageGetOAuthProviders,
        reload: vi.fn(),
      })),
    },
  };
});

// ── Mock Store ────────────────────────────────────────────────────────

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1821-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1821-test/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 0 }),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    };
  }

  async getSettingsByScope() {
    return {
      global: { defaultProvider: "anthropic", defaultModelId: "claude-3-5-sonnet" },
      project: { maxConcurrent: 2 },
    };
  }

  getGlobalSettingsStore() {
    return {
      async getSettings() {
        return { defaultProvider: "anthropic", defaultModelId: "claude-3-5-sonnet" };
      },
    };
  }
}

// ── Test helpers ──────────────────────────────────────────────────────

function createMockRemoteNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-remote-001",
    name: "Remote Node",
    type: "remote" as const,
    status: "online" as const,
    url: "http://192.168.1.100:3001",
    apiKey: "test-api-key-123",
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMockLocalNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-local-001",
    name: "Local Node",
    type: "local" as const,
    status: "online" as const,
    url: null,
    apiKey: "local-api-key-456",
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Node settings sync routes", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListNodes.mockResolvedValue([]);
    mockGetNode.mockResolvedValue(null);
    mockGetLocalPeerInfo.mockResolvedValue({ nodeId: "node-local-001", nodeName: "Local Node" });
    mockGetSettingsSyncState.mockResolvedValue(null);
    mockUpdateSettingsSyncState.mockResolvedValue({});
    mockApplyRemoteSettings.mockResolvedValue({ success: true, globalCount: 1, projectCount: 1, authCount: 0 });
    mockGetSettingsForSync.mockResolvedValue({});
    mockAuthStorageSet.mockResolvedValue(undefined);
    mockAuthStorageGetOAuthProviders.mockReturnValue([]);

    // Mock global fetch for remote node calls
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── GET /api/nodes/:id/settings ──────────────────────────────────────

  describe("GET /api/nodes/:id/settings", () => {
    it("returns remote settings scopes for valid remote node", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ global: { test: "global" }, project: { test: "project" } }),
      });

      const res = await get(app, "/api/nodes/node-remote-001/settings");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ global: { test: "global" }, project: { test: "project" } });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://192.168.1.100:3001/api/settings/scopes",
        expect.objectContaining({
          method: "GET",
          headers: { Authorization: "Bearer test-api-key-123", "Content-Type": "application/json" },
        }),
      );
    });

    it("returns 404 for unknown node", async () => {
      mockGetNode.mockResolvedValue(null);

      const res = await get(app, "/api/nodes/unknown/settings");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });

    it("returns 400 for local node", async () => {
      const localNode = createMockLocalNode();
      mockGetNode.mockResolvedValue(localNode);

      const res = await get(app, "/api/nodes/node-local-001/settings");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("local node");
    });

    it("returns 502 when remote returns non-200", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const res = await get(app, "/api/nodes/node-remote-001/settings");

      expect(res.status).toBe(502);
      expect(res.body.error).toContain("500");
    });

    it("returns 504 when remote is unreachable", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockRejectedValue(new Error("Network error"));

      const res = await get(app, "/api/nodes/node-remote-001/settings");

      expect(res.status).toBe(504);
      expect(res.body.error).toContain("unreachable");
    });
  });

  // ── POST /api/nodes/:id/settings/push ────────────────────────────────

  describe("POST /api/nodes/:id/settings/push", () => {
    it("successfully pushes local settings to remote", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/push",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.syncedFields).toContain("defaultProvider");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://192.168.1.100:3001/api/settings/sync-receive",
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer test-api-key-123", "Content-Type": "application/json" },
        }),
      );
    });

    it("returns 404 for unknown node", async () => {
      mockGetNode.mockResolvedValue(null);

      const res = await request(
        app,
        "POST",
        "/api/nodes/unknown/settings/push",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(404);
    });

    it("returns 400 for local node", async () => {
      const localNode = createMockLocalNode();
      mockGetNode.mockResolvedValue(localNode);

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-local-001/settings/push",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("local node");
    });

    it("returns 400 for remote node without apiKey", async () => {
      const remoteNode = createMockRemoteNode({ apiKey: undefined });
      mockGetNode.mockResolvedValue(remoteNode);

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/push",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("apiKey");
    });

    it("records sync state after successful push", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/push",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(mockUpdateSettingsSyncState).toHaveBeenCalledWith(
        "node-remote-001",
        expect.objectContaining({
          lastSyncedAt: expect.any(String),
        }),
      );
    });
  });

  // ── POST /api/nodes/:id/settings/pull ───────────────────────────────

  describe("POST /api/nodes/:id/settings/pull", () => {
    it("successfully pulls and applies remote settings with default conflict resolution", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          global: { defaultProvider: "openai" },
          project: { maxConcurrent: 3 },
        }),
      });

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/pull",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockApplyRemoteSettings).toHaveBeenCalled();
    });

    it("returns diff without applying when conflictResolution is manual", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          global: { defaultProvider: "openai" },
          project: { maxConcurrent: 3 },
        }),
      });

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/pull",
        JSON.stringify({ conflictResolution: "manual" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.diff).toBeDefined();
      expect(res.body.remoteSettings).toBeDefined();
      expect(res.body.localSettings).toBeDefined();
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
    });

    it("returns 404 for unknown node", async () => {
      mockGetNode.mockResolvedValue(null);

      const res = await request(
        app,
        "POST",
        "/api/nodes/unknown/settings/pull",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(404);
    });

    it("records sync state after successful pull", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          global: { defaultProvider: "openai" },
          project: { maxConcurrent: 3 },
        }),
      });

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/pull",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(mockUpdateSettingsSyncState).toHaveBeenCalledWith(
        "node-remote-001",
        expect.objectContaining({
          lastSyncedAt: expect.any(String),
        }),
      );
    });
  });

  // ── GET /api/nodes/:id/settings/sync-status ─────────────────────────

  describe("GET /api/nodes/:id/settings/sync-status", () => {
    it("returns sync status with diff summary when remote is reachable", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockGetSettingsSyncState.mockResolvedValue({
        nodeId: "node-local-001",
        remoteNodeId: "node-remote-001",
        lastSyncedAt: "2026-04-14T10:00:00.000Z",
        localChecksum: "abc123",
        remoteChecksum: "def456",
        syncCount: 5,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-04-14T10:00:00.000Z",
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          global: { defaultProvider: "openai" },
          project: { maxConcurrent: 3 },
        }),
      });

      const res = await get(app, "/api/nodes/node-remote-001/settings/sync-status");

      expect(res.status).toBe(200);
      expect(res.body.lastSyncAt).toBe("2026-04-14T10:00:00.000Z");
      expect(res.body.remoteReachable).toBe(true);
      expect(res.body.diff).toBeDefined();
    });

    it("returns remoteReachable false with empty diff when remote is down", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockGetSettingsSyncState.mockResolvedValue(null);
      mockFetch.mockRejectedValue(new Error("Network error"));

      const res = await get(app, "/api/nodes/node-remote-001/settings/sync-status");

      expect(res.status).toBe(200);
      expect(res.body.remoteReachable).toBe(false);
      expect(res.body.diff.global).toEqual([]);
      expect(res.body.diff.project).toEqual([]);
    });

    it("returns 404 for unknown node", async () => {
      mockGetNode.mockResolvedValue(null);

      const res = await get(app, "/api/nodes/unknown/settings/sync-status");

      expect(res.status).toBe(404);
    });

    it("returns null timestamps when no sync has occurred", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockGetSettingsSyncState.mockResolvedValue(null);
      mockFetch.mockRejectedValue(new Error("Network error"));

      const res = await get(app, "/api/nodes/node-remote-001/settings/sync-status");

      expect(res.status).toBe(200);
      expect(res.body.lastSyncAt).toBe(null);
    });
  });

  // ── POST /api/nodes/:id/auth/sync ───────────────────────────────────

  describe("POST /api/nodes/:id/auth/sync", () => {
    it("successfully pushes auth credentials to remote (push mode)", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/auth/sync",
        JSON.stringify({ direction: "push" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // The actual providers depend on what's in ~/.pi/agent/auth.json
      // We just verify the sync completed successfully
      expect(Array.isArray(res.body.syncedProviders)).toBe(true);
    });

    it("returns 404 for unknown node", async () => {
      mockGetNode.mockResolvedValue(null);

      const res = await request(
        app,
        "POST",
        "/api/nodes/unknown/auth/sync",
        JSON.stringify({ direction: "push" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(404);
    });

    it("returns 400 for remote node without apiKey", async () => {
      const remoteNode = createMockRemoteNode({ apiKey: undefined });
      mockGetNode.mockResolvedValue(remoteNode);

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/auth/sync",
        JSON.stringify({ direction: "push" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("apiKey");
    });

    it("logs provider names but not credentials", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/auth/sync",
        JSON.stringify({ direction: "push" }),
        { "content-type": "application/json" },
      );

      // Verify that some providers were logged
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("providers="),
      );
      // Verify that API keys are not logged
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("sk-"),
      );
      consoleSpy.mockRestore();
    });

    it("successfully pulls auth credentials from remote", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          providers: {
            google: { type: "api_key", key: "AIzaTest123" },
          },
          sourceNodeId: "node-other",
          timestamp: "2026-04-14T10:00:00.000Z",
        }),
      });

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/auth/sync",
        JSON.stringify({ direction: "pull" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.syncedProviders).toContain("google");
    });
  });

  // ── POST /api/settings/sync-receive ─────────────────────────────────

  describe("POST /api/settings/sync-receive", () => {
    it("successfully receives and applies settings", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);
      mockApplyRemoteSettings.mockResolvedValue({
        success: true,
        globalCount: 2,
        projectCount: 1,
        authCount: 0,
      });

      const payload = {
        global: { defaultProvider: "anthropic" },
        projects: {},
        exportedAt: "2026-04-14T10:00:00.000Z",
        checksum: "abc123",
        version: 1,
      };

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({ ...payload, sourceNodeId: "node-remote-001" }),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockApplyRemoteSettings).toHaveBeenCalled();
    });

    it("returns 401 when auth header is missing", async () => {
      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({ sourceNodeId: "node-remote-001", exportedAt: "2026-04-14T10:00:00.000Z" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(401);
    });

    it("returns 401 when apiKey doesn't match", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({ sourceNodeId: "node-remote-001", exportedAt: "2026-04-14T10:00:00.000Z" }),
        { "content-type": "application/json", "Authorization": "Bearer wrong-key" },
      );

      expect(res.status).toBe(401);
    });

    it("returns 400 when payload is missing sourceNodeId", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({ exportedAt: "2026-04-14T10:00:00.000Z" }),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("sourceNodeId");
    });
  });

  // ── POST /api/settings/auth-receive ──────────────────────────────────

  describe("POST /api/settings/auth-receive", () => {
    it("successfully receives auth credentials", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);

      const res = await request(
        app,
        "POST",
        "/api/settings/auth-receive",
        JSON.stringify({
          providers: {
            anthropic: { type: "api_key", key: "sk-ant-received" },
          },
          sourceNodeId: "node-remote-001",
          timestamp: "2026-04-14T10:00:00.000Z",
        }),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.receivedProviders).toContain("anthropic");
    });

    it("returns 401 when auth header is missing", async () => {
      const res = await request(
        app,
        "POST",
        "/api/settings/auth-receive",
        JSON.stringify({
          providers: { anthropic: { type: "api_key", key: "sk-ant" } },
          sourceNodeId: "node-remote-001",
          timestamp: "2026-04-14T10:00:00.000Z",
        }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(401);
    });

    it("returns 400 when payload is malformed", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);

      const res = await request(
        app,
        "POST",
        "/api/settings/auth-receive",
        JSON.stringify({ providers: "not-an-object" }),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(400);
    });

    it("logs provider names but not credentials", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await request(
        app,
        "POST",
        "/api/settings/auth-receive",
        JSON.stringify({
          providers: { anthropic: { type: "api_key", key: "sk-ant-secret" } },
          sourceNodeId: "node-remote-001",
          timestamp: "2026-04-14T10:00:00.000Z",
        }),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("anthropic"),
      );
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("sk-ant-secret"),
      );
      consoleSpy.mockRestore();
    });
  });

  // ── GET /api/settings/auth-export ────────────────────────────────────

  describe("GET /api/settings/auth-export", () => {
    it("returns auth credentials for authenticated request", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);
      mockGetLocalPeerInfo.mockResolvedValue({ nodeId: "node-local-001", nodeName: "Local Node" });

      const res = await request(
        app,
        "GET",
        "/api/settings/auth-export",
        undefined,
        { "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(200);
      expect(res.body.providers).toBeDefined();
      expect(res.body.sourceNodeId).toBe("node-local-001");
      // The actual providers depend on what's in ~/.pi/agent/auth.json
      // Just verify we got a providers object
      expect(typeof res.body.providers).toBe("object");
    });

    it("returns 401 when auth header is missing", async () => {
      const res = await get(app, "/api/settings/auth-export");

      expect(res.status).toBe(401);
    });
  });
});
