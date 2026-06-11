import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request, get } from "../test-request.js";
import { createServer } from "../server.js";
import { MISSING_REMOTE_NODE_API_KEY_MESSAGE } from "../routes/register-settings-sync-helpers.js";

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

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListNodes = vi.fn();
const mockGetNode = vi.fn();
const mockGetLocalPeerInfo = vi.fn();
const mockGetSettingsSyncState = vi.fn();
const mockUpdateSettingsSyncState = vi.fn();
const mockApplyRemoteSettings = vi.fn();
const mockGetSettingsForSync = vi.fn();
const mockGetAuthMaterialSnapshot = vi.fn();
const mockApplyAuthMaterialSnapshot = vi.fn();
const mockChatStoreInit = vi.fn().mockResolvedValue(undefined);
const mockAgentStoreInit = vi.fn().mockResolvedValue(undefined);
const mockAgentStoreGetAgent = vi.fn().mockResolvedValue(null);

vi.mock("@fusion/core", async (importOriginal) => {
  const __actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...__actual,
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
      getAuthMaterialSnapshot = mockGetAuthMaterialSnapshot;
      applyAuthMaterialSnapshot = mockApplyAuthMaterialSnapshot;
    },
    ChatStore: class MockChatStore {
      init = mockChatStoreInit;
    },
    AgentStore: class MockAgentStore {
      init = mockAgentStoreInit;
      getAgent = mockAgentStoreGetAgent;
    },
    deterministicGuardLocks: new Map(),
  };
});

const mockAuthStorageSet = vi.fn();
const mockAuthStorageGetOAuthProviders = vi.fn().mockReturnValue([]);

vi.mock("@earendil-works/pi-coding-agent", () => {
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

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-4755-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-4755-test/.fusion";
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

  listWorkflowSettingValuesForProject(): Record<string, Record<string, unknown>> {
    return {};
  }

  getWorkflowSettingsProjectId(): string {
    return "project-local-001";
  }

  async updateWorkflowSettingValues(_workflowId: string, _projectId: string, patch: Record<string, unknown>) {
    return patch;
  }
}

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

type SyncEndpoint = {
  name: string;
  method: "GET" | "POST";
  path: string;
  direction: "outbound" | "inbound";
  requiresNodeApiKey?: boolean;
  requiresBearer?: boolean;
  sampleBody?: () => unknown;
  exceptions?: string[];
};

const ENDPOINTS: readonly SyncEndpoint[] = [
  { name: "get-settings", method: "GET", path: "/api/nodes/node-remote-001/settings", direction: "outbound", requiresNodeApiKey: true },
  { name: "push-settings", method: "POST", path: "/api/nodes/node-remote-001/settings/push", direction: "outbound", requiresNodeApiKey: true, sampleBody: () => ({}) },
  { name: "pull-settings", method: "POST", path: "/api/nodes/node-remote-001/settings/pull", direction: "outbound", requiresNodeApiKey: true, sampleBody: () => ({ conflictResolution: "last-write-wins" }) },
  {
    name: "sync-status",
    method: "GET",
    path: "/api/nodes/node-remote-001/settings/sync-status",
    direction: "outbound",
    requiresNodeApiKey: true,
    exceptions: ["missing-node-apiKey-returns-200-degraded", "missing-node-url-returns-200-degraded"], // Why: endpoint intentionally degrades to remoteReachable=false instead of throwing.
  },
  { name: "auth-sync", method: "POST", path: "/api/nodes/node-remote-001/auth/sync", direction: "outbound", requiresNodeApiKey: true, sampleBody: () => ({}) },
  { name: "secrets-push", method: "POST", path: "/api/nodes/node-remote-001/secrets/push", direction: "outbound", requiresNodeApiKey: true, sampleBody: () => ({}) },
  { name: "secrets-pull", method: "POST", path: "/api/nodes/node-remote-001/secrets/pull", direction: "outbound", requiresNodeApiKey: true, sampleBody: () => ({}) },
  { name: "sync-receive", method: "POST", path: "/api/settings/sync-receive", direction: "inbound", requiresBearer: true, sampleBody: () => ({ sourceNodeId: "node-1", exportedAt: "2026-04-14T10:00:00.000Z" }) },
  { name: "auth-receive", method: "POST", path: "/api/settings/auth-receive", direction: "inbound", requiresBearer: true, sampleBody: () => ({ authMaterial: {}, sourceNodeId: "node-1", timestamp: "2026-04-14T10:00:00.000Z" }) },
  { name: "auth-export", method: "GET", path: "/api/settings/auth-export", direction: "inbound", requiresBearer: true },
  { name: "secrets-receive", method: "POST", path: "/api/secrets/sync-receive", direction: "inbound", requiresBearer: true, sampleBody: () => ({ sourceNodeId: "node-1", exportedAt: "2026-04-14T10:00:00.000Z", version: 1, ciphertext: "", salt: "", nonce: "", kdf: "scrypt", kdfParams: { N: 32768, r: 8, p: 1, keyLen: 32 } }) },
  { name: "secrets-export", method: "GET", path: "/api/secrets/sync-export", direction: "inbound", requiresBearer: true },
] as const;

describe("Node settings/auth sync contract matrix", () => {
  let store: MockStore;
  let app: ReturnType<typeof createServer>;
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
    mockApplyRemoteSettings.mockResolvedValue({ success: true, globalCount: 1, projectCount: 1, authCount: 0, workflowSettingsCount: 0 });
    mockGetSettingsForSync.mockResolvedValue({});
    mockGetAuthMaterialSnapshot.mockReturnValue({
      version: 1,
      exportedAt: "2026-04-14T10:00:00.000Z",
      checksum: "auth-checksum",
      payload: { providerAuth: { anthropic: { type: "api_key", key: "sk-ant-test" } } },
    });
    mockApplyAuthMaterialSnapshot.mockReturnValue({
      success: true,
      authCount: 1,
      providerAuth: { anthropic: { type: "api_key", key: "sk-ant-received" } },
    });
    mockAuthStorageSet.mockResolvedValue(undefined);
    mockAuthStorageGetOAuthProviders.mockReturnValue([]);

    mockFetch = vi.fn();
    global.fetch = mockFetch;

    store = new MockStore();
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(ENDPOINTS.filter((endpoint) => endpoint.direction === "outbound" && endpoint.requiresNodeApiKey))(
    "enforces outbound missing remote apiKey contract ($name)",
    async (endpoint) => {
      if (endpoint.exceptions?.includes("missing-node-apiKey-returns-200-degraded")) {
        return;
      }

      const remoteNode = createMockRemoteNode({ apiKey: undefined });
      mockGetNode.mockResolvedValue(remoteNode);

      const body = endpoint.sampleBody ? JSON.stringify(endpoint.sampleBody()) : undefined;
      const headers = endpoint.method === "POST" ? { "content-type": "application/json" } : undefined;
      const res = endpoint.method === "GET"
        ? await get(app, endpoint.path)
        : await request(app, endpoint.method, endpoint.path, body, headers);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it.each(ENDPOINTS.filter((endpoint) => endpoint.direction === "outbound" && endpoint.requiresNodeApiKey))(
    "enforces outbound missing remote URL contract ($name) [url=null]",
    async (endpoint) => {
      if (endpoint.exceptions?.includes("missing-node-url-returns-200-degraded")) {
        return;
      }

      const remoteNode = createMockRemoteNode({ url: null });
      mockGetNode.mockResolvedValue(remoteNode);

      const body = endpoint.sampleBody ? JSON.stringify(endpoint.sampleBody()) : undefined;
      const headers = endpoint.method === "POST" ? { "content-type": "application/json" } : undefined;
      const res = endpoint.method === "GET"
        ? await get(app, endpoint.path)
        : await request(app, endpoint.method, endpoint.path, body, headers);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Node has no URL configured");
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it.each(ENDPOINTS.filter((endpoint) => endpoint.direction === "outbound" && endpoint.requiresNodeApiKey))(
    "enforces outbound missing remote URL contract ($name) [url=empty]",
    async (endpoint) => {
      if (endpoint.exceptions?.includes("missing-node-url-returns-200-degraded")) {
        return;
      }

      const remoteNode = createMockRemoteNode({ url: "" });
      mockGetNode.mockResolvedValue(remoteNode);

      const body = endpoint.sampleBody ? JSON.stringify(endpoint.sampleBody()) : undefined;
      const headers = endpoint.method === "POST" ? { "content-type": "application/json" } : undefined;
      const res = endpoint.method === "GET"
        ? await get(app, endpoint.path)
        : await request(app, endpoint.method, endpoint.path, body, headers);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Node has no URL configured");
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it("sync-status returns remoteReachable=false for missing apiKey", async () => {
    const remoteNode = createMockRemoteNode({ apiKey: undefined });
    mockGetNode.mockResolvedValue(remoteNode);

    const res = await get(app, "/api/nodes/node-remote-001/settings/sync-status");

    expect(res.status).toBe(200);
    expect(res.body.remoteReachable).toBe(false);
    expect(res.body.diff).toEqual({ global: [], project: [], workflowSettings: {} });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([null, ""])("sync-status returns remoteReachable=false for missing URL [url=%p]", async (urlValue) => {
    const remoteNode = createMockRemoteNode({ url: urlValue });
    mockGetNode.mockResolvedValue(remoteNode);

    const res = await get(app, "/api/nodes/node-remote-001/settings/sync-status");

    expect(res.status).toBe(200);
    expect(res.body.remoteReachable).toBe(false);
    expect(res.body.diff).toEqual({ global: [], project: [], workflowSettings: {} });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("missing URL takes precedence over missing apiKey for outbound sync", async () => {
    const remoteNode = createMockRemoteNode({ url: null, apiKey: undefined });
    mockGetNode.mockResolvedValue(remoteNode);

    const res = await get(app, "/api/nodes/node-remote-001/settings");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Node has no URL configured");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(ENDPOINTS.filter((endpoint) => endpoint.direction === "inbound"))(
    "returns 401 for missing Authorization header ($name)",
    async (endpoint) => {
      const body = endpoint.sampleBody ? JSON.stringify(endpoint.sampleBody()) : undefined;
      const headers = endpoint.method === "POST" ? { "content-type": "application/json" } : undefined;
      const res = await request(app, endpoint.method, endpoint.path, body, headers);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Missing or invalid Authorization header");
    },
  );

  it.each(ENDPOINTS.filter((endpoint) => endpoint.direction === "inbound"))(
    "returns 401 for wrong auth scheme ($name)",
    async (endpoint) => {
      const body = endpoint.sampleBody ? JSON.stringify(endpoint.sampleBody()) : undefined;
      const headers = endpoint.method === "POST"
        ? { "content-type": "application/json", Authorization: "Token abc" }
        : { Authorization: "Token abc" };
      const res = await request(app, endpoint.method, endpoint.path, body, headers);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Missing or invalid Authorization header");
    },
  );

  it.each(ENDPOINTS.filter((endpoint) => endpoint.direction === "inbound"))(
    "returns 401 for mismatched bearer token ($name)",
    async (endpoint) => {
      mockListNodes.mockResolvedValue([createMockLocalNode()]);
      const body = endpoint.sampleBody ? JSON.stringify(endpoint.sampleBody()) : undefined;
      const headers = endpoint.method === "POST"
        ? { "content-type": "application/json", Authorization: "Bearer wrong-token" }
        : { Authorization: "Bearer wrong-token" };

      const res = await request(app, endpoint.method, endpoint.path, body, headers);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid apiKey");
    },
  );

  it.each(ENDPOINTS.filter((endpoint) => endpoint.direction === "inbound"))(
    "returns 401 when local node is not configured ($name)",
    async (endpoint) => {
      mockListNodes.mockResolvedValue([]);
      const body = endpoint.sampleBody ? JSON.stringify(endpoint.sampleBody()) : undefined;
      const headers = endpoint.method === "POST"
        ? { "content-type": "application/json", Authorization: "Bearer local-api-key-456" }
        : { Authorization: "Bearer local-api-key-456" };

      const res = await request(app, endpoint.method, endpoint.path, body, headers);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Local node not configured");
    },
  );

  it("push payload is accepted by inbound sync-receive", async () => {
    // Regression backstop for FN-4752 (push→sync-receive sourceNodeId).
    mockGetNode.mockResolvedValue(createMockRemoteNode());
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });

    const pushRes = await request(
      app,
      "POST",
      "/api/nodes/node-remote-001/settings/push",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(pushRes.status).toBe(200);

    const [, pushOptions] = mockFetch.mock.calls[0] as [string, { body?: string }];
    const pushBody = pushOptions.body;
    expect(typeof pushBody).toBe("string");

    const localNode = createMockLocalNode();
    mockListNodes.mockResolvedValue([localNode]);
    const inboundRes = await request(
      app,
      "POST",
      "/api/settings/sync-receive",
      pushBody,
      { "content-type": "application/json", Authorization: `Bearer ${localNode.apiKey}` },
    );

    expect(inboundRes.status).toBe(200);
  });

  it("pull returns NodeSettingsSyncResult-compatible success shape", async () => {
    mockGetNode.mockResolvedValue(createMockRemoteNode());
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
    expect(res.body).toEqual(expect.objectContaining({ success: true }));
    expect(typeof res.body.success).toBe("boolean");
    if (res.body.syncedFields !== undefined) {
      expect(Array.isArray(res.body.syncedFields)).toBe(true);
    }
    if (res.body.appliedFields !== undefined) {
      expect(Array.isArray(res.body.appliedFields)).toBe(true);
    }
    if (res.body.skippedFields !== undefined) {
      expect(Array.isArray(res.body.skippedFields)).toBe(true);
    }
  });

  it("auth-sync payload is accepted by inbound auth-receive", async () => {
    // Regression backstop for FN-4752 symmetry (auth/sync→auth-receive required fields).
    mockGetNode.mockResolvedValue(createMockRemoteNode());
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });

    const syncRes = await request(
      app,
      "POST",
      "/api/nodes/node-remote-001/auth/sync",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );

    expect(syncRes.status).toBe(200);
    const [, syncOptions] = mockFetch.mock.calls[0] as [string, { body?: string }];
    const outboundBody = JSON.parse(syncOptions.body ?? "{}");
    expect(outboundBody).toEqual(expect.objectContaining({
      authMaterial: expect.any(Object),
      sourceNodeId: expect.any(String),
      timestamp: expect.any(String),
    }));

    const localNode = createMockLocalNode();
    mockListNodes.mockResolvedValue([localNode]);
    const inboundRes = await request(
      app,
      "POST",
      "/api/settings/auth-receive",
      JSON.stringify(outboundBody),
      { "content-type": "application/json", Authorization: `Bearer ${localNode.apiKey}` },
    );

    expect(inboundRes.status).toBe(200);
  });

  it("auth-export returns auth-receive compatible response shape", async () => {
    const localNode = createMockLocalNode();
    mockListNodes.mockResolvedValue([localNode]);

    const res = await request(
      app,
      "GET",
      "/api/settings/auth-export",
      undefined,
      { Authorization: `Bearer ${localNode.apiKey}` },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      authMaterial: expect.any(Object),
      sourceNodeId: expect.any(String),
      timestamp: expect.any(String),
    }));
  });
});
