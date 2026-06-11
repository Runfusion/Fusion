import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request, get } from "../test-request.js";
import { createServer } from "../server.js";
import { resetRuntimeLogSink, setRuntimeLogSink, type RuntimeLogContext } from "../runtime-logger.js";
import { MISSING_REMOTE_NODE_API_KEY_MESSAGE } from "../routes/register-settings-sync-helpers.js";
import { computeSettingsDiff } from "../routes/register-settings-sync-routes.js";
import { MOVED_SETTINGS_KEYS } from "@fusion/core";

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
const mockGetAuthMaterialSnapshot = vi.fn();
const mockApplyAuthMaterialSnapshot = vi.fn();
const mockStoreUpdateGlobalSettings = vi.fn().mockResolvedValue({});
const mockUpdateWorkflowSettingValues = vi.fn().mockResolvedValue({});
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

// ── Mock AuthStorage ───────────────────────────────────────────────────

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

// ── Mock Store ────────────────────────────────────────────────────────

class MockStore extends EventEmitter {
  workflowSettings: Record<string, Record<string, unknown>> = {
    "builtin:coding": { workflowStepTimeoutMs: 120000 },
  };

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

  async updateGlobalSettings(patch: Record<string, unknown>) {
    return mockStoreUpdateGlobalSettings(patch);
  }

  listWorkflowSettingValuesForProject(): Record<string, Record<string, unknown>> {
    return this.workflowSettings;
  }

  getWorkflowSettingsProjectId(): string {
    return "project-local-001";
  }

  async updateWorkflowSettingValues(workflowId: string, projectId: string, patch: Record<string, unknown>) {
    return mockUpdateWorkflowSettingValues(workflowId, projectId, patch);
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

describe("computeSettingsDiff", () => {
  it("diffs workflow settings per workflow while filtering moved flat keys", () => {
    const movedKey = MOVED_SETTINGS_KEYS[0];
    const diff = computeSettingsDiff(
      {
        global: { defaultProvider: "openai", [movedKey]: "remote" },
        project: { maxConcurrent: 3, [movedKey]: 123 },
        workflowSettings: {
          "builtin:coding": { workflowStepTimeoutMs: 120000, reviewModel: "claude" },
          "WF-remote": { executionModel: "gpt-5" },
        },
      },
      { defaultProvider: "anthropic", [movedKey]: "local" },
      { maxConcurrent: 2, [movedKey]: 456 },
      {
        "builtin:coding": { workflowStepTimeoutMs: 120000, reviewModel: "gpt-4" },
        "WF-local": { executionModel: "claude" },
      },
    );

    expect(diff.global).toEqual(["defaultProvider"]);
    expect(diff.project).toEqual(["maxConcurrent"]);
    expect(diff.workflowSettings).toEqual({
      "builtin:coding": ["reviewModel"],
      "WF-remote": ["executionModel"],
      "WF-local": ["executionModel"],
    });
  });
});

interface RuntimeEvent {
  level: "info" | "warn" | "error";
  scope: string;
  message: string;
  context?: RuntimeLogContext;
}

describe("Node settings sync routes", () => {
  let store: MockStore;
  let app: ReturnType<typeof createServer>;
  let mockFetch: ReturnType<typeof vi.fn>;
  let runtimeEvents: RuntimeEvent[];

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
    mockStoreUpdateGlobalSettings.mockReset();
    mockUpdateWorkflowSettingValues.mockReset().mockResolvedValue({});
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

    // Mock global fetch for remote node calls
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    runtimeEvents = [];
    setRuntimeLogSink((level, scope, message, context) => {
      runtimeEvents.push({ level, scope, message, context });
    });

    store = new MockStore();
    app = createServer(store as any);
  });

  afterEach(() => {
    resetRuntimeLogSink();
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
      expect(res.body.syncedFields).toContain("workflowStepTimeoutMs");
      const [, pushOptions] = mockFetch.mock.calls[0] as [string, { body?: string }];
      expect(JSON.parse(pushOptions.body ?? "{}").workflowSettings).toEqual({
        "builtin:coding": { workflowStepTimeoutMs: 120000 },
      });
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
      expect(res.body.error).toBe(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
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

    it("applies remote workflow settings locally with last-write-wins", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          global: { defaultProvider: "openai" },
          project: { maxConcurrent: 3 },
          workflowSettings: { "builtin:coding": { workflowStepTimeoutMs: 240000 } },
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
      expect(res.body.appliedFields).toContain("workflowStepTimeoutMs");
      expect(res.body.workflowSettingsCount).toBe(1);
      expect(mockUpdateWorkflowSettingValues).toHaveBeenCalledWith(
        "builtin:coding",
        "project-local-001",
        { workflowStepTimeoutMs: 240000 },
      );
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
      expect(res.body.diff.workflowSettings).toEqual({
        "builtin:coding": ["workflowStepTimeoutMs"],
      });
      expect(res.body.remoteSettings).toBeDefined();
      expect(res.body.localSettings.workflowSettings).toEqual({
        "builtin:coding": { workflowStepTimeoutMs: 120000 },
      });
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
    });

    it("does NOT record sync state when conflictResolution is manual (read-only inspection contract)", async () => {
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
      expect(mockUpdateSettingsSyncState).not.toHaveBeenCalled();
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
    });

    it("manual pull does not mutate central sync state (parity with sync-status)", async () => {
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
      expect(mockUpdateSettingsSyncState.mock.calls.length).toBe(0);
      expect(res.body).toEqual(expect.objectContaining({
        diff: expect.any(Object),
        remoteSettings: expect.any(Object),
        localSettings: expect.any(Object),
      }));
      expect(res.body.lastSyncedAt).toBeUndefined();
      expect(res.body.lastSyncAt).toBeUndefined();
      expect(Object.keys(res.body).sort()).toEqual(["diff", "localSettings", "remoteSettings"]);
    });

    it("manual diff includes local-only keys that are absent from remote", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          global: { defaultProvider: "openai" },
          project: { maxConcurrent: 3 },
        }),
      });
      vi.spyOn(store, "getSettingsByScope").mockResolvedValue({
        global: {},
        project: { worktreesDir: "/tmp/wt" },
      });
      vi.spyOn(store, "getGlobalSettingsStore").mockReturnValue({
        getSettings: vi.fn().mockResolvedValue({ defaultModelId: "gpt-5" }),
      } as ReturnType<MockStore["getGlobalSettingsStore"]>);

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/pull",
        JSON.stringify({ conflictResolution: "manual" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.diff.global).toEqual(expect.arrayContaining(["defaultProvider", "defaultModelId"]));
      expect(res.body.diff.project).toEqual(expect.arrayContaining(["maxConcurrent", "worktreesDir"]));
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
    });

    it("manual diff EXCLUDES moved keys even when a mid-migration remote peer still carries them (KTD-8)", async () => {
      const movedProjectKey = MOVED_SETTINGS_KEYS[0]; // e.g. workflowStepTimeoutMs
      const movedGlobalKey = MOVED_SETTINGS_KEYS.find((k) => k === "executionProvider") ?? MOVED_SETTINGS_KEYS[1];
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      // REAL post-broadcast shape: an unmigrated peer's /settings/scopes still lists
      // moved keys flat under global/project, with values that DIFFER from local.
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          global: { defaultProvider: "openai", [movedGlobalKey]: "anthropic" },
          project: { maxConcurrent: 3, [movedProjectKey]: 999_999 },
        }),
      });
      // Migrated local node: no moved keys present at all.
      vi.spyOn(store, "getSettingsByScope").mockResolvedValue({
        global: {},
        project: { maxConcurrent: 1 },
      });
      vi.spyOn(store, "getGlobalSettingsStore").mockReturnValue({
        getSettings: vi.fn().mockResolvedValue({ defaultProvider: "anthropic" }),
      } as ReturnType<MockStore["getGlobalSettingsStore"]>);

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/pull",
        JSON.stringify({ conflictResolution: "manual" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      // Non-moved differences still surface.
      expect(res.body.diff.global).toContain("defaultProvider");
      expect(res.body.diff.project).toContain("maxConcurrent");
      // Moved keys NEVER appear in the diff, despite differing values.
      expect(res.body.diff.global).not.toContain(movedGlobalKey);
      expect(res.body.diff.project).not.toContain(movedProjectKey);
      for (const k of MOVED_SETTINGS_KEYS) {
        expect(res.body.diff.global).not.toContain(k);
        expect(res.body.diff.project).not.toContain(k);
      }
    });

    it("returns 400 for local node", async () => {
      const localNode = createMockLocalNode();
      mockGetNode.mockResolvedValue(localNode);

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-local-001/settings/pull",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("local node");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid conflictResolution", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/pull",
        JSON.stringify({ conflictResolution: "invalid" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("conflictResolution");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
      expect(mockUpdateSettingsSyncState).not.toHaveBeenCalled();
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

    it("returns skippedFields and error when applyRemoteSettings fails", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          global: { defaultProvider: "openai" },
          project: { maxConcurrent: 3 },
        }),
      });
      mockApplyRemoteSettings.mockResolvedValue({ success: false, error: "checksum mismatch" });

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/pull",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.skippedFields).toEqual(expect.arrayContaining(["defaultProvider"]));
      expect(res.body.error).toContain("checksum mismatch");
      expect(mockApplyRemoteSettings).toHaveBeenCalledTimes(1);
      expect(mockUpdateSettingsSyncState).toHaveBeenCalledTimes(1);
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
          remoteChecksum: expect.any(String),
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
      expect(res.body.diff.workflowSettings).toEqual({
        "builtin:coding": ["workflowStepTimeoutMs"],
      });
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

    it("diff includes local-only keys when remote reachable", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockGetSettingsSyncState.mockResolvedValue(null);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          global: { defaultProvider: "openai" },
          project: { maxConcurrent: 3 },
        }),
      });
      vi.spyOn(store, "getSettingsByScope").mockResolvedValue({
        global: {},
        project: { worktreesDir: "/tmp/wt" },
      });
      vi.spyOn(store, "getGlobalSettingsStore").mockReturnValue({
        getSettings: vi.fn().mockResolvedValue({ defaultModelId: "gpt-5" }),
      } as ReturnType<MockStore["getGlobalSettingsStore"]>);

      const res = await get(app, "/api/nodes/node-remote-001/settings/sync-status");

      expect(res.status).toBe(200);
      expect(res.body.remoteReachable).toBe(true);
      expect(res.body.diff.global).toEqual(expect.arrayContaining(["defaultProvider", "defaultModelId"]));
      expect(res.body.diff.project).toEqual(expect.arrayContaining(["maxConcurrent", "worktreesDir"]));
    });

    it("diff stays empty when remote unreachable even if local has unique keys", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockGetSettingsSyncState.mockResolvedValue(null);
      mockFetch.mockRejectedValue(new Error("Network error"));
      vi.spyOn(store, "getSettingsByScope").mockResolvedValue({
        global: {},
        project: { worktreesDir: "/tmp/wt" },
      });
      vi.spyOn(store, "getGlobalSettingsStore").mockReturnValue({
        getSettings: vi.fn().mockResolvedValue({ defaultModelId: "gpt-5" }),
      } as ReturnType<MockStore["getGlobalSettingsStore"]>);

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

    it("returns 400 for local node", async () => {
      const localNode = createMockLocalNode();
      mockGetNode.mockResolvedValue(localNode);

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-local-001/auth/sync",
        JSON.stringify({ direction: "push" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("local node");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockUpdateSettingsSyncState).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid direction", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/auth/sync",
        JSON.stringify({ direction: "sideways" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("direction");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockUpdateSettingsSyncState).not.toHaveBeenCalled();
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
      expect(res.body.error).toBe(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
    });

    it("emits structured redacted diagnostics for push-mode auth sync", async () => {
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
      const authEvent = runtimeEvents.find((event) =>
        event.message === "Auth sync diagnostic event"
        && event.context?.route === "/nodes/:id/auth/sync"
        && event.context?.direction === "push"
      );

      expect(authEvent).toMatchObject({
        level: "info",
        message: "Auth sync diagnostic event",
        context: expect.objectContaining({
          operation: "sync",
          direction: "push",
          route: "/nodes/:id/auth/sync",
          sourceNodeId: "node-local-001",
          targetNodeId: "node-remote-001",
          providerNames: res.body.syncedProviders,
          providerCount: res.body.syncedProviders.length,
        }),
      });
      expect(authEvent?.scope.endsWith("routes:settings-sync:auth")).toBe(true);
      expect(authEvent?.context).toHaveProperty("targetNodeId", "node-remote-001");

      const serialized = JSON.stringify(authEvent);
      expect(serialized).not.toContain("sk-");
      expect(serialized).not.toContain("Bearer ");
      expect(serialized).not.toContain("\"key\"");
      expect(serialized).not.toContain("\"access\"");
      expect(serialized).not.toContain("\"refresh\"");
    });

    it("records sync state for pull-mode auth sync", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          authMaterial: {
            version: 1,
            exportedAt: "2026-04-14T10:00:00.000Z",
            checksum: "auth-checksum",
            payload: { providerAuth: { google: { type: "api_key", key: "sk-pull-secret-123" } } },
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
      expect(mockUpdateSettingsSyncState).toHaveBeenCalledWith(
        "node-remote-001",
        expect.objectContaining({
          lastSyncedAt: expect.any(String),
        }),
      );
    });

    it("emits structured redacted diagnostics for pull-mode auth sync", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockApplyAuthMaterialSnapshot.mockReturnValueOnce({
        success: true,
        authCount: 1,
        providerAuth: {
          google: { type: "api_key", key: "sk-pull-secret-123" },
        },
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          authMaterial: {
            version: 1,
            exportedAt: "2026-04-14T10:00:00.000Z",
            checksum: "auth-checksum",
            payload: {
              providerAuth: {
                google: { type: "api_key", key: "sk-pull-secret-123" },
              },
            },
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

      const authEvent = runtimeEvents.find((event) =>
        event.message === "Auth sync diagnostic event"
        && event.context?.route === "/nodes/:id/auth/sync"
        && event.context?.direction === "pull"
      );

      expect(authEvent).toMatchObject({
        level: "info",
        message: "Auth sync diagnostic event",
        context: expect.objectContaining({
          operation: "sync",
          direction: "pull",
          route: "/nodes/:id/auth/sync",
          sourceNodeId: "node-other",
          targetNodeId: "node-local-001",
          providerNames: ["google"],
          providerCount: 1,
        }),
      });
      expect(authEvent?.scope.endsWith("routes:settings-sync:auth")).toBe(true);
      expect(authEvent?.context).toHaveProperty("sourceNodeId", "node-other");
      expect(authEvent?.context).toHaveProperty("targetNodeId", "node-local-001");

      const serialized = JSON.stringify(authEvent);
      expect(serialized).not.toContain("sk-pull-secret-123");
      expect(serialized).not.toContain("Bearer ");
      expect(serialized).not.toContain("\"key\"");
      expect(serialized).not.toContain("\"access\"");
      expect(serialized).not.toContain("\"refresh\"");
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
      expect(res.body.workflowSettingsCount).toBe(0);
      expect(mockApplyRemoteSettings).toHaveBeenCalled();
    });

    it("applies inbound workflow settings through the workflow settings write path", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);
      mockApplyRemoteSettings.mockResolvedValue({
        success: true,
        globalCount: 0,
        projectCount: 0,
        authCount: 0,
      });

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({
          sourceNodeId: "node-remote-001",
          exportedAt: "2026-04-14T10:00:00.000Z",
          checksum: "abc123",
          version: 1,
          workflowSettings: { "builtin:coding": { workflowStepTimeoutMs: 240000 } },
        }),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.appliedFields).toContain("workflowStepTimeoutMs");
      expect(res.body.workflowSettingsCount).toBe(1);
      expect(mockUpdateWorkflowSettingValues).toHaveBeenCalledWith(
        "builtin:coding",
        "project-local-001",
        { workflowStepTimeoutMs: 240000 },
      );
    });

    it("drops invalid inbound workflow settings without failing the sync", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);
      mockApplyRemoteSettings.mockResolvedValue({
        success: true,
        globalCount: 0,
        projectCount: 0,
        authCount: 0,
      });
      mockUpdateWorkflowSettingValues
        .mockRejectedValueOnce(Object.assign(new Error("bad setting"), {
          rejections: [{ settingId: "invalidSetting" }],
        }))
        .mockResolvedValueOnce({});

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({
          sourceNodeId: "node-remote-001",
          exportedAt: "2026-04-14T10:00:00.000Z",
          checksum: "abc123",
          version: 1,
          workflowSettings: {
            "builtin:coding": {
              workflowStepTimeoutMs: 240000,
              invalidSetting: "bad",
            },
          },
        }),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.appliedFields).toContain("workflowStepTimeoutMs");
      expect(res.body.appliedFields).not.toContain("invalidSetting");
      expect(res.body.workflowSettingsCount).toBe(1);
      expect(mockUpdateWorkflowSettingValues).toHaveBeenNthCalledWith(
        2,
        "builtin:coding",
        "project-local-001",
        { workflowStepTimeoutMs: 240000 },
      );
    });

    it("applies inbound global settings via store.updateGlobalSettings when local values are unset", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);
      mockApplyRemoteSettings.mockResolvedValue({
        success: true,
        globalCount: 2,
        projectCount: 0,
        authCount: 0,
      });

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({
          sourceNodeId: "node-remote-001",
          exportedAt: "2026-04-14T10:00:00.000Z",
          checksum: "abc123",
          version: 1,
          global: { dashboardCurrentNodeId: "node-remote-001", defaultProvider: "openai" },
        }),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(200);
      expect(mockStoreUpdateGlobalSettings).toHaveBeenCalledWith({ dashboardCurrentNodeId: "node-remote-001" });
    });

    it("drops moved keys from an inbound push: never applied to global settings, never in appliedFields (KTD-8)", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);
      mockApplyRemoteSettings.mockResolvedValue({
        success: true,
        globalCount: 1,
        projectCount: 0,
        authCount: 0,
      });
      const movedGlobalKey = MOVED_SETTINGS_KEYS.find((k) => k === "executionProvider") ?? MOVED_SETTINGS_KEYS[0];

      // REAL post-broadcast payload from a mid-migration peer: a moved key rides
      // along under `global` next to a legitimate new key.
      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({
          sourceNodeId: "node-remote-001",
          exportedAt: "2026-04-14T10:00:00.000Z",
          checksum: "abc123",
          version: 1,
          global: { newLegitKey: "value-x", [movedGlobalKey]: "anthropic" },
        }),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(200);
      // The legit key is applied; the moved key is NOT in the patch.
      const patches = mockStoreUpdateGlobalSettings.mock.calls.map((c) => c[0] as Record<string, unknown>);
      const applied = Object.assign({}, ...patches) as Record<string, unknown>;
      expect(applied.newLegitKey).toBe("value-x");
      expect(applied[movedGlobalKey]).toBeUndefined();
      // appliedFields reported back also excludes the moved key.
      expect(res.body.appliedFields).toContain("newLegitKey");
      expect(res.body.appliedFields).not.toContain(movedGlobalKey);
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
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
    });

    it("returns 400 when payload is missing exportedAt", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({ sourceNodeId: "node-remote-001" }),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("exportedAt");
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
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
          authMaterial: {
            version: 1,
            exportedAt: "2026-04-14T10:00:00.000Z",
            checksum: "auth-checksum",
            payload: { providerAuth: { anthropic: { type: "api_key", key: "sk-ant-received" } } },
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
          authMaterial: {
            version: 1,
            exportedAt: "2026-04-14T10:00:00.000Z",
            checksum: "auth-checksum",
            payload: { providerAuth: { anthropic: { type: "api_key", key: "sk-ant" } } },
          },
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
        JSON.stringify({ authMaterial: "not-an-object" }),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(400);
    });

    it.each([
      [{ authMaterial: { version: 1, exportedAt: "2026-04-14T10:00:00.000Z", checksum: "auth-checksum", payload: { providerAuth: {} } }, timestamp: "2026-04-14T10:00:00.000Z" }, "sourceNodeId"],
      [{ authMaterial: { version: 1, exportedAt: "2026-04-14T10:00:00.000Z", checksum: "auth-checksum", payload: { providerAuth: {} } }, sourceNodeId: "node-remote-001" }, "timestamp"],
    ])("returns 400 when payload is missing %s", async (body, missingField) => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);

      const res = await request(
        app,
        "POST",
        "/api/settings/auth-receive",
        JSON.stringify(body),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain(missingField);
      expect(mockAuthStorageSet).not.toHaveBeenCalled();
    });

    it("emits structured redacted diagnostics for auth-receive", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);

      const res = await request(
        app,
        "POST",
        "/api/settings/auth-receive",
        JSON.stringify({
          authMaterial: {
            version: 1,
            exportedAt: "2026-04-14T10:00:00.000Z",
            checksum: "auth-checksum",
            payload: { providerAuth: { anthropic: { type: "api_key", key: "sk-ant-secret" } } },
          },
          sourceNodeId: "node-remote-001",
          timestamp: "2026-04-14T10:00:00.000Z",
        }),
        { "content-type": "application/json", "Authorization": `Bearer ${localNode.apiKey}` },
      );

      expect(res.status).toBe(200);
      const authEvent = runtimeEvents.find((event) =>
        event.message === "Auth sync diagnostic event"
        && event.context?.route === "/settings/auth-receive"
        && event.context?.direction === "receive"
      );

      expect(authEvent).toMatchObject({
        level: "info",
        message: "Auth sync diagnostic event",
        context: {
          operation: "receive",
          direction: "receive",
          route: "/settings/auth-receive",
          sourceNodeId: "node-remote-001",
          providerNames: ["anthropic"],
          providerCount: 1,
        },
      });
      expect(authEvent?.scope.endsWith("routes:settings-sync:auth")).toBe(true);
      expect(authEvent?.context).not.toHaveProperty("targetNodeId");

      const serialized = JSON.stringify(authEvent);
      expect(serialized).not.toContain("sk-ant-secret");
      expect(serialized).not.toContain("Bearer ");
      expect(serialized).not.toContain("\"key\"");
      expect(serialized).not.toContain("\"access\"");
      expect(serialized).not.toContain("\"refresh\"");
    });
  });

  describe("FN-4869: inbound sync rejects empty local apiKey (FN-4868 G-01)", () => {
    const syncReceiveBody = {
      sourceNodeId: "node-remote-001",
      exportedAt: "2026-04-14T10:00:00.000Z",
    };
    const authReceiveBody = {
      authMaterial: {
        version: 1,
        exportedAt: "2026-04-14T10:00:00.000Z",
        checksum: "x",
        payload: { providerAuth: {} },
      },
      sourceNodeId: "node-remote-001",
      timestamp: "2026-04-14T10:00:00.000Z",
    };

    const routeCases = [
      {
        method: "POST" as const,
        route: "/api/settings/sync-receive",
        body: syncReceiveBody,
        assertRejectedMutation: (res: { body: unknown }) => {
          expect(res.body).not.toHaveProperty("authMaterial");
          expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
          expect(mockApplyAuthMaterialSnapshot).not.toHaveBeenCalled();
        },
        assertAcceptedMutation: () => {
          expect(mockApplyRemoteSettings).toHaveBeenCalledTimes(1);
          expect(mockApplyAuthMaterialSnapshot).not.toHaveBeenCalled();
        },
      },
      {
        method: "POST" as const,
        route: "/api/settings/auth-receive",
        body: authReceiveBody,
        assertRejectedMutation: (res: { body: unknown }) => {
          expect(res.body).not.toHaveProperty("authMaterial");
          expect(mockApplyAuthMaterialSnapshot).not.toHaveBeenCalled();
          expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
        },
        assertAcceptedMutation: () => {
          expect(mockApplyAuthMaterialSnapshot).toHaveBeenCalledTimes(1);
          expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
        },
      },
      {
        method: "GET" as const,
        route: "/api/settings/auth-export",
        body: undefined,
        assertRejectedMutation: (res: { body: unknown }) => {
          expect(res.body).not.toHaveProperty("authMaterial");
          expect(mockApplyAuthMaterialSnapshot).not.toHaveBeenCalled();
          expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
        },
        assertAcceptedMutation: () => {
          expect(mockApplyAuthMaterialSnapshot).not.toHaveBeenCalled();
          expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
        },
      },
    ] as const;

    const localApiKeyStates = [
      { label: "empty string", localNode: createMockLocalNode({ apiKey: "" }) },
      { label: "undefined", localNode: createMockLocalNode({ apiKey: undefined }) },
    ] as const;

    const authHeaders = ["Bearer ", "Bearer anything-non-empty"] as const;
    const rejectionCases = routeCases.flatMap((routeCase) =>
      localApiKeyStates.flatMap((apiKeyState) =>
        authHeaders.map((authHeader) => [routeCase, apiKeyState, authHeader] as const),
      ));

    it.each(rejectionCases)(
      "returns 401 for %s when local apiKey is %s and header is %s",
      async (routeCase, apiKeyState, authHeader) => {
        mockListNodes.mockResolvedValue([apiKeyState.localNode]);

        const res = await request(
          app,
          routeCase.method,
          routeCase.route,
          routeCase.body ? JSON.stringify(routeCase.body) : undefined,
          routeCase.method === "POST"
            ? { "content-type": "application/json", Authorization: authHeader }
            : { Authorization: authHeader },
        );

        expect(res.status).toBe(401);
        routeCase.assertRejectedMutation(res);
        expect(mockAuthStorageSet).not.toHaveBeenCalled();
      },
    );

    it.each(routeCases.flatMap((routeCase) =>
      localApiKeyStates.flatMap((apiKeyState) =>
        ["Bearer null", "Bearer undefined"].map((authHeader) => [routeCase, apiKeyState, authHeader] as const))))(
      "returns 401 for %s when local apiKey is %s and literal header is %s",
      async (routeCase, apiKeyState, authHeader) => {
        mockListNodes.mockResolvedValue([apiKeyState.localNode]);

        const res = await request(
          app,
          routeCase.method,
          routeCase.route,
          routeCase.body ? JSON.stringify(routeCase.body) : undefined,
          routeCase.method === "POST"
            ? { "content-type": "application/json", Authorization: authHeader }
            : { Authorization: authHeader },
        );

        expect(res.status).toBe(401);
        routeCase.assertRejectedMutation(res);
        expect(mockAuthStorageSet).not.toHaveBeenCalled();
      },
    );

    it.each(routeCases)(
      "positive control: returns 200 for %s when local apiKey matches header",
      async (routeCase) => {
        const localNode = createMockLocalNode({ apiKey: "local-api-key-456" });
        mockListNodes.mockResolvedValue([localNode]);

        const res = await request(
          app,
          routeCase.method,
          routeCase.route,
          routeCase.body ? JSON.stringify(routeCase.body) : undefined,
          routeCase.method === "POST"
            ? { "content-type": "application/json", Authorization: "Bearer local-api-key-456" }
            : { Authorization: "Bearer local-api-key-456" },
        );

        expect(res.status).toBe(200);
        routeCase.assertAcceptedMutation();
      },
    );
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
      expect(res.body.authMaterial).toBeDefined();
      expect(res.body.sourceNodeId).toBe("node-local-001");
      // The actual providers depend on what's in ~/.pi/agent/auth.json
      // Just verify we got a providerAuth snapshot payload
      expect(typeof res.body.authMaterial.payload.providerAuth).toBe("object");
    });

    it("returns 401 when auth header is missing", async () => {
      const res = await get(app, "/api/settings/auth-export");

      expect(res.status).toBe(401);
    });

    it.each([
      ["POST", "/api/settings/sync-receive", JSON.stringify({ sourceNodeId: "node-remote-001", exportedAt: "2026-04-14T10:00:00.000Z" }), "applyRemoteSettings"],
      ["POST", "/api/settings/auth-receive", JSON.stringify({ authMaterial: { version: 1, exportedAt: "2026-04-14T10:00:00.000Z", checksum: "auth-checksum", payload: { providerAuth: {} } }, sourceNodeId: "node-remote-001", timestamp: "2026-04-14T10:00:00.000Z" }), "authStorageSet"],
      ["GET", "/api/settings/auth-export", undefined, "authExport"],
    ])("returns 401 Local node not configured for inbound endpoint (%s %s)", async (method, path, body, sideEffect) => {
      mockListNodes.mockResolvedValue([createMockRemoteNode()]);

      const res = await request(
        app,
        method,
        path,
        body,
        { "content-type": "application/json", Authorization: "Bearer some-token" },
      );

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Local node not configured");
      if (sideEffect === "applyRemoteSettings") {
        expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
      }
      if (sideEffect === "authStorageSet") {
        expect(mockAuthStorageSet).not.toHaveBeenCalled();
      }
    });
  });

  describe("FN-4747 parity coverage", () => {
    it("captures push payload contract sent to /settings/sync-receive", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/push",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      const [, fetchOptions] = mockFetch.mock.calls[0] as [string, { body?: string }];
      const postedBody = JSON.parse(fetchOptions.body ?? "{}");
      expect(postedBody).toEqual(expect.objectContaining({
        global: expect.any(Object),
        projects: expect.any(Object),
        workflowSettings: { "builtin:coding": { workflowStepTimeoutMs: 120000 } },
        exportedAt: expect.any(String),
        version: 1,
        checksum: expect.any(String),
      }));
      expect(postedBody.sourceNodeId).toEqual(expect.any(String));
      expect(postedBody.sourceNodeId.length).toBeGreaterThan(0);

      const { createHash } = await import("node:crypto");
      const expectedChecksum = createHash("sha256")
        .update(JSON.stringify({
          global: postedBody.global,
          projects: postedBody.projects,
          workflowSettings: postedBody.workflowSettings,
          exportedAt: postedBody.exportedAt,
          version: postedBody.version,
        }))
        .digest("hex");
      expect(postedBody.checksum).toBe(expectedChecksum);
    });

    it("accepts the exact push payload in inbound sync-receive round-trip", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });

      const pushRes = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/push",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(pushRes.status).toBe(200);
      const [, fetchOptions] = mockFetch.mock.calls[0] as [string, { body?: string }];
      const pushedPayloadBody = fetchOptions.body;
      expect(typeof pushedPayloadBody).toBe("string");

      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);
      mockApplyRemoteSettings.mockResolvedValue({
        success: true,
        globalCount: 2,
        projectCount: 1,
        authCount: 0,
      });

      const inboundRes = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        pushedPayloadBody,
        { "content-type": "application/json", Authorization: `Bearer ${localNode.apiKey}` },
      );

      expect(inboundRes.status).toBe(200);
      expect(inboundRes.body.success).toBe(true);
      expect(inboundRes.body.error).toBeUndefined();
      expect(mockApplyRemoteSettings).toHaveBeenCalled();
    });

    it.each([
      ["GET", "/api/nodes/node-remote-001/settings", 400],
      ["POST", "/api/nodes/node-remote-001/settings/push", 400],
      ["POST", "/api/nodes/node-remote-001/settings/pull", 400],
      ["POST", "/api/nodes/node-remote-001/auth/sync", 400],
      ["GET", "/api/nodes/node-remote-001/settings/sync-status", 200],
    ])("enforces missing apiKey contract for outbound endpoint (%s %s)", async (method, path, expectedStatus) => {
      const remoteNode = createMockRemoteNode({ apiKey: undefined });
      mockGetNode.mockResolvedValue(remoteNode);

      const res = method === "GET"
        ? await request(app, method, path)
        : await request(app, method, path, JSON.stringify({}), { "content-type": "application/json" });

      expect(res.status).toBe(expectedStatus);
      if (expectedStatus === 400) {
        expect(res.body.error).toBe(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
      } else {
        expect(res.body.remoteReachable).toBe(false);
        expect(res.body.diff).toEqual({ global: [], project: [], workflowSettings: {} });
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([
      ["POST", "/api/settings/sync-receive"],
      ["POST", "/api/settings/auth-receive"],
      ["GET", "/api/settings/auth-export"],
    ])("returns 401 for missing header on inbound endpoint (%s %s)", async (method, path) => {
      const res = method === "GET"
        ? await request(app, method, path)
        : await request(app, method, path, JSON.stringify({ sourceNodeId: "node-1", exportedAt: "2026-04-14T10:00:00.000Z" }), { "content-type": "application/json" });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Missing or invalid Authorization header");
    });

    it.each([
      ["POST", "/api/settings/sync-receive", JSON.stringify({ sourceNodeId: "node-1", exportedAt: "2026-04-14T10:00:00.000Z" })],
      ["POST", "/api/settings/auth-receive", JSON.stringify({ authMaterial: {}, sourceNodeId: "node-1", timestamp: "2026-04-14T10:00:00.000Z" })],
      ["GET", "/api/settings/auth-export", undefined],
    ])("returns 401 for wrong auth scheme on inbound endpoint (%s %s)", async (method, path, body) => {
      const res = await request(app, method, path, body, { "content-type": "application/json", Authorization: "Token abc" });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Missing or invalid Authorization header");
    });

    it.each([
      ["POST", "/api/settings/sync-receive", JSON.stringify({ sourceNodeId: "node-1", exportedAt: "2026-04-14T10:00:00.000Z" })],
      ["POST", "/api/settings/auth-receive", JSON.stringify({ authMaterial: {}, sourceNodeId: "node-1", timestamp: "2026-04-14T10:00:00.000Z" })],
      ["GET", "/api/settings/auth-export", undefined],
    ])("returns 401 for mismatched bearer token on inbound endpoint (%s %s)", async (method, path, body) => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);

      const res = await request(app, method, path, body, { "content-type": "application/json", Authorization: "Bearer wrong-token" });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid apiKey");
    });
  });

  describe("FN-4833 auth/ownership hardening", () => {
    it("round-trips a cross-node push through outbound /settings/push and inbound /settings/sync-receive", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });

      const pushRes = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/push",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      // FN-4833 auth/ownership hardening backstop for Node Settings Sync endpoints.
      expect(pushRes.status).toBe(200);
      const [fetchUrl, fetchOptions] = mockFetch.mock.calls[0] as [string, { headers?: Record<string, string>; body?: string }];
      expect(fetchUrl).toContain("/api/settings/sync-receive");
      expect(fetchOptions.headers?.Authorization).toBe("Bearer test-api-key-123");

      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);
      mockApplyRemoteSettings.mockResolvedValue({ success: true, globalCount: 1, projectCount: 1, authCount: 0, workflowSettingsCount: 0 });

      const inboundRes = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        fetchOptions.body,
        { "content-type": "application/json", Authorization: `Bearer ${localNode.apiKey}` },
      );

      // FN-4833 auth/ownership hardening backstop for Node Settings Sync endpoints.
      expect(inboundRes.status).toBe(200);
      expect(mockApplyRemoteSettings).toHaveBeenCalledTimes(1);
      const appliedPayload = mockApplyRemoteSettings.mock.calls[0]?.[0] as { sourceNodeId?: string };
      expect(appliedPayload.sourceNodeId).toBe("node-local-001");
    });

    it("round-trips a cross-node pull through /settings/pull → applyRemoteSettings", async () => {
      const remoteNode = createMockRemoteNode();
      mockGetNode.mockResolvedValue(remoteNode);
      const remotePayload = {
        global: { plannerModel: "gpt-5" },
        project: { defaultProvider: "openai" },
      };
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(remotePayload) });
      mockApplyRemoteSettings.mockResolvedValue({ success: true, globalCount: 1, projectCount: 1, authCount: 0, workflowSettingsCount: 0 });

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/pull",
        JSON.stringify({ conflictResolution: "last-write-wins" }),
        { "content-type": "application/json" },
      );

      // FN-4833 auth/ownership hardening backstop for Node Settings Sync endpoints.
      expect(res.status).toBe(200);
      expect(mockFetch.mock.calls[0]?.[1]?.headers?.Authorization).toBe("Bearer test-api-key-123");
      expect(mockApplyRemoteSettings).toHaveBeenCalledTimes(1);
      const appliedPayload = mockApplyRemoteSettings.mock.calls[0]?.[0] as {
        global: Record<string, unknown>;
        projects: Record<string, unknown>;
        exportedAt: string;
        version: number;
        checksum: string;
      };
      const { createHash } = await import("node:crypto");
      const expectedChecksum = createHash("sha256")
        .update(JSON.stringify({
          global: appliedPayload.global,
          projects: appliedPayload.projects,
          exportedAt: appliedPayload.exportedAt,
          version: appliedPayload.version,
        }))
        .digest("hex");
      expect(appliedPayload.checksum).toBe(expectedChecksum);
    });

    it.each([
      ["GET", "/api/nodes/node-remote-001/settings"],
      ["POST", "/api/nodes/node-remote-001/settings/push"],
      ["POST", "/api/nodes/node-remote-001/settings/pull"],
      ["GET", "/api/nodes/node-remote-001/settings/sync-status"],
      ["POST", "/api/nodes/node-remote-001/auth/sync"],
    ])("sends Bearer ${node.apiKey} on outbound %s %s", async (method, path) => {
      mockGetNode.mockResolvedValue(createMockRemoteNode());
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ global: {}, project: {}, authMaterial: { payload: { providerAuth: {} } }, sourceNodeId: "node-remote-001", timestamp: "2026-05-16T00:00:00.000Z" }) });

      const res = method === "GET"
        ? await request(app, method, path)
        : await request(app, method, path, JSON.stringify({}), { "content-type": "application/json" });

      // FN-4833 auth/ownership hardening backstop for Node Settings Sync endpoints.
      expect([200, 502]).toContain(res.status);
      expect(mockFetch.mock.calls[0]?.[1]?.headers?.Authorization).toBe("Bearer test-api-key-123");
    });

    it.each([
      ["POST", "/api/settings/sync-receive", JSON.stringify({ sourceNodeId: "node-remote-001", exportedAt: "2026-05-16T00:00:00.000Z" })],
      ["POST", "/api/settings/auth-receive", JSON.stringify({ authMaterial: { version: 1, exportedAt: "2026-05-16T00:00:00.000Z", checksum: "x", payload: { providerAuth: {} } }, sourceNodeId: "node-remote-001", timestamp: "2026-05-16T00:00:00.000Z" })],
      ["GET", "/api/settings/auth-export", undefined],
    ])("rejects bearer matching a remote node's apiKey (not local) on %s %s", async (method, path, body) => {
      mockListNodes.mockResolvedValue([createMockLocalNode(), createMockRemoteNode()]);

      const res = await request(
        app,
        method,
        path,
        body,
        { "content-type": "application/json", Authorization: "Bearer test-api-key-123" },
      );

      // FN-4833 auth/ownership hardening backstop for Node Settings Sync endpoints.
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid apiKey");
    });

    it.each([
      ["GET", "/api/nodes/node-local-001/settings", 400],
      ["POST", "/api/nodes/node-local-001/settings/push", 400],
      ["POST", "/api/nodes/node-local-001/settings/pull", 400],
      ["GET", "/api/nodes/node-local-001/settings/sync-status", 400],
      ["POST", "/api/nodes/node-local-001/auth/sync", 400],
    ])("rejects local-node target on outbound %s %s with 400", async (method, path, expectedStatus) => {
      mockGetNode.mockResolvedValue(createMockLocalNode());

      const res = method === "GET"
        ? await request(app, method, path)
        : await request(app, method, path, JSON.stringify({}), { "content-type": "application/json" });

      // FN-4833 auth/ownership hardening backstop for Node Settings Sync endpoints.
      expect(res.status).toBe(expectedStatus);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([
      ["GET", "/api/nodes/unknown/settings"],
      ["POST", "/api/nodes/unknown/settings/push"],
      ["POST", "/api/nodes/unknown/settings/pull"],
      ["GET", "/api/nodes/unknown/settings/sync-status"],
      ["POST", "/api/nodes/unknown/auth/sync"],
    ])("returns 404 Node not found on outbound %s %s", async (method, path) => {
      mockGetNode.mockResolvedValue(null);

      const res = method === "GET"
        ? await request(app, method, path)
        : await request(app, method, path, JSON.stringify({}), { "content-type": "application/json" });

      // FN-4833 auth/ownership hardening backstop for Node Settings Sync endpoints.
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Node not found");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("emits a redacted auth-sync diagnostic on POST /api/nodes/:id/auth/sync push without leaking credentials", async () => {
      mockGetNode.mockResolvedValue(createMockRemoteNode());
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/auth/sync",
        JSON.stringify({ direction: "push" }),
        { "content-type": "application/json" },
      );

      const authEvent = runtimeEvents.find((event) =>
        event.scope.endsWith("routes:settings-sync:auth")
        && event.context?.operation === "sync"
        && event.context?.direction === "push"
        && event.context?.route === "/nodes/:id/auth/sync",
      );

      // FN-4833 auth/ownership hardening backstop for Node Settings Sync endpoints.
      expect(res.status).toBe(200);
      expect(authEvent).toBeDefined();
      expect(JSON.stringify(authEvent)).not.toContain("sk-ant-");
      expect(JSON.stringify(authEvent)).not.toContain("Bearer ");
    });
  });

  describe("FN-4847 auth/ownership edge cases", () => {
    it("treats apiKey: null identically to apiKey: '' on outbound push", async () => {
      mockGetNode.mockResolvedValue({ ...createMockRemoteNode(), apiKey: null as unknown as string });

      const res = await request(app, "POST", "/api/nodes/node-remote-001/settings/push", JSON.stringify({}), { "content-type": "application/json" });

      // FN-4847 edge-case backstop for Node Settings Sync auth/ownership.
      // Null apiKey must follow the same falsy guard as empty-string/missing keys and short-circuit before fetch.
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([
      ["no Authorization header", undefined],
      ["empty Authorization header", ""],
      ["wrong scheme: Basic", "Basic test-api-key-123"],
      ["wrong scheme: lowercase bearer", "bearer test-api-key-123"],
      ["Bearer with empty token", "Bearer "],
      ["Bearer with leading whitespace token", "Bearer  test-api-key-123"],
      ["Bearer with trailing whitespace token", "Bearer test-api-key-123 "],
      ["mismatched token", "Bearer not-the-local-key"],
    ])("rejects %s on POST /api/settings/sync-receive with 401", async (_name, authorization) => {
      mockListNodes.mockResolvedValue([createMockLocalNode()]);

      const headers = authorization === undefined
        ? { "content-type": "application/json" }
        : { "content-type": "application/json", Authorization: authorization };
      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({ sourceNodeId: "node-remote-001", exportedAt: "2026-05-17T00:00:00.000Z", global: {}, projects: {} }),
        headers,
      );

      // FN-4847 edge-case backstop for Node Settings Sync auth/ownership.
      // Bearer parsing must reject malformed and mismatched variants before any settings mutation executes.
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Missing or invalid Authorization header|Invalid apiKey/);
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
    });

    it.each([
      ["no Authorization header", undefined],
      ["empty Authorization header", ""],
      ["wrong scheme: Basic", "Basic test-api-key-123"],
      ["wrong scheme: lowercase bearer", "bearer test-api-key-123"],
      ["Bearer with empty token", "Bearer "],
      ["Bearer with leading whitespace token", "Bearer  test-api-key-123"],
      ["Bearer with trailing whitespace token", "Bearer test-api-key-123 "],
      ["mismatched token", "Bearer not-the-local-key"],
    ])("rejects %s on POST /api/settings/auth-receive with 401", async (_name, authorization) => {
      mockListNodes.mockResolvedValue([createMockLocalNode()]);

      const headers = authorization === undefined
        ? { "content-type": "application/json" }
        : { "content-type": "application/json", Authorization: authorization };
      const res = await request(
        app,
        "POST",
        "/api/settings/auth-receive",
        JSON.stringify({
          authMaterial: { version: 1, exportedAt: "2026-05-17T00:00:00.000Z", checksum: "auth-checksum", payload: { providerAuth: {} } },
          sourceNodeId: "node-remote-001",
          timestamp: "2026-05-17T00:00:00.000Z",
        }),
        headers,
      );

      // FN-4847 edge-case backstop for Node Settings Sync auth/ownership.
      // Auth material import must enforce identical bearer checks and avoid storage writes on denied auth.
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Missing or invalid Authorization header|Invalid apiKey/);
      expect(mockAuthStorageSet).not.toHaveBeenCalled();
    });

    it("rejects auth-receive with sourceNodeId=<local node id> when bearer is wrong", async () => {
      mockListNodes.mockResolvedValue([createMockLocalNode()]);

      const res = await request(
        app,
        "POST",
        "/api/settings/auth-receive",
        JSON.stringify({
          authMaterial: { version: 1, exportedAt: "2026-05-16T00:00:00.000Z", checksum: "auth-checksum", payload: { providerAuth: {} } },
          sourceNodeId: "node-local-001",
          timestamp: "2026-05-16T00:00:00.000Z",
        }),
        { "content-type": "application/json", Authorization: "Bearer wrong" },
      );

      // FN-4847 edge-case backstop for Node Settings Sync auth/ownership.
      // A body claiming local-node source identity must never bypass bearer equality checks.
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid apiKey");
      expect(mockAuthStorageSet).not.toHaveBeenCalled();
    });

    it("sync-status reports actionableDenialReason='missing-remote-api-key' when remote node has no apiKey", async () => {
      mockGetNode.mockResolvedValue({ ...createMockRemoteNode(), apiKey: "" });

      const res = await request(app, "GET", "/api/nodes/node-remote-001/settings/sync-status");

      // FN-4847 edge-case backstop for Node Settings Sync auth/ownership.
      // Sync-status must expose a stable denial enum when outbound auth cannot even be attempted.
      expect(res.status).toBe(200);
      expect(res.body.remoteReachable).toBe(false);
      expect(res.body.actionableDenialReason).toBe("missing-remote-api-key");
      expect(res.body.diff).toEqual({ global: [], project: [], workflowSettings: {} });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sync-status reports actionableDenialReason='auth-failed' when remote returns HTTP 401", async () => {
      mockGetNode.mockResolvedValue(createMockRemoteNode());
      mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") } as Response);

      const res = await request(app, "GET", "/api/nodes/node-remote-001/settings/sync-status");

      // FN-4847 edge-case backstop for Node Settings Sync auth/ownership.
      // Remote auth failures must be surfaced as an actionable enum rather than silent degraded reachability.
      expect(res.status).toBe(200);
      expect(res.body.remoteReachable).toBe(false);
      expect(res.body.actionableDenialReason).toBe("auth-failed");
    });

    it("sync-status also maps remote HTTP 403 to actionableDenialReason='auth-failed'", async () => {
      mockGetNode.mockResolvedValue(createMockRemoteNode());
      mockFetch.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("forbidden") } as Response);

      const res = await request(app, "GET", "/api/nodes/node-remote-001/settings/sync-status");

      // FN-4847 edge-case backstop for Node Settings Sync auth/ownership.
      // fetchFromRemoteNode intentionally collapses remote 401/403 into one wrapped auth-failed contract.
      expect(res.status).toBe(200);
      expect(res.body.remoteReachable).toBe(false);
      expect(res.body.actionableDenialReason).toBe("auth-failed");
    });

    it("sync-status reports actionableDenialReason='unreachable' on network failure", async () => {
      mockGetNode.mockResolvedValue(createMockRemoteNode());
      mockFetch.mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }));

      const res = await request(app, "GET", "/api/nodes/node-remote-001/settings/sync-status");

      // FN-4847 edge-case backstop for Node Settings Sync auth/ownership.
      // Connection failures must be classified as unreachable so operators get actionable diagnostics.
      expect(res.status).toBe(200);
      expect(res.body.remoteReachable).toBe(false);
      expect(res.body.actionableDenialReason).toBe("unreachable");
    });

    it("sync-status maps AbortError to actionableDenialReason='unreachable'", async () => {
      mockGetNode.mockResolvedValue(createMockRemoteNode());
      mockFetch.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));

      const res = await request(app, "GET", "/api/nodes/node-remote-001/settings/sync-status");

      // FN-4847 edge-case backstop for Node Settings Sync auth/ownership.
      // Timeout/abort failures should map to the same unreachable denial reason as other network errors.
      expect(res.status).toBe(200);
      expect(res.body.remoteReachable).toBe(false);
      expect(res.body.actionableDenialReason).toBe("unreachable");
    });

    it("sync-status reports actionableDenialReason='unknown' on remote HTTP 500", async () => {
      mockGetNode.mockResolvedValue(createMockRemoteNode());
      mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("oops") } as Response);

      const res = await request(app, "GET", "/api/nodes/node-remote-001/settings/sync-status");

      // FN-4847 edge-case backstop for Node Settings Sync auth/ownership.
      // Non-auth upstream failures should classify as unknown rather than leaking transport details.
      expect(res.status).toBe(200);
      expect(res.body.remoteReachable).toBe(false);
      expect(res.body.actionableDenialReason).toBe("unknown");
    });

    it("sync-status returns actionableDenialReason: null when the remote probe succeeds", async () => {
      mockGetNode.mockResolvedValue(createMockRemoteNode());
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ global: {}, project: {} }) } as Response);

      const res = await request(app, "GET", "/api/nodes/node-remote-001/settings/sync-status");

      // FN-4847 edge-case backstop for Node Settings Sync auth/ownership.
      // Successful probes should include an explicit null denial reason to keep the response shape stable.
      expect(res.status).toBe(200);
      expect(res.body.remoteReachable).toBe(true);
      expect(res.body.actionableDenialReason).toBeNull();
    });

    it("sync-status actionableDenialReason never includes underlying error text or URLs", async () => {
      mockGetNode.mockResolvedValue(createMockRemoteNode());
      mockFetch.mockRejectedValue(new Error("http://remote.invalid/api/settings/scopes — secret-fragment"));

      const res = await request(app, "GET", "/api/nodes/node-remote-001/settings/sync-status");

      // FN-4847 edge-case backstop for Node Settings Sync auth/ownership.
      // Denial diagnostics must stay enum-only and never reflect sensitive message or URL fragments.
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain("secret-fragment");
      expect(JSON.stringify(res.body)).not.toContain("remote.invalid");
    });
  });

  describe("FN-4862 node-settings sync auth/ownership backstop", () => {
    it("blocks POST /api/nodes/:id/settings/push when remote node apiKey is empty string and never calls fetch", async () => {
      mockGetNode.mockResolvedValue({ ...createMockRemoteNode(), apiKey: "" });

      const res = await request(app, "POST", "/api/nodes/node-remote-001/settings/push", JSON.stringify({}), { "content-type": "application/json" });

      // FN-4862 node-settings sync auth/ownership backstop.
      // Empty-string apiKey must be rejected the same as missing apiKey to prevent unauthenticated outbound sync.
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("blocks POST /api/nodes/:id/settings/pull when remote node apiKey is empty string and never calls fetch", async () => {
      mockGetNode.mockResolvedValue({ ...createMockRemoteNode(), apiKey: "" });

      const res = await request(
        app,
        "POST",
        "/api/nodes/node-remote-001/settings/pull",
        JSON.stringify({ conflictResolution: "last-write-wins" }),
        { "content-type": "application/json" },
      );

      // FN-4862 node-settings sync auth/ownership backstop.
      // Pull must short-circuit before remote calls when apiKey is empty to avoid unauthorized fetch attempts.
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([
      ["empty Authorization header", ""],
      ["wrong scheme: Basic", "Basic test-api-key-123"],
      ["wrong scheme: lowercase bearer", "bearer test-api-key-123"],
      ["Bearer with empty token", "Bearer "],
      ["Bearer with trailing whitespace token", "Bearer test-api-key-123 "],
    ])("rejects %s on POST /api/settings/sync-receive with 401", async (_name, authorization) => {
      mockListNodes.mockResolvedValue([createMockLocalNode()]);

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({ sourceNodeId: "node-remote-001", exportedAt: "2026-05-17T00:00:00.000Z", global: {}, projects: {} }),
        { "content-type": "application/json", Authorization: authorization },
      );

      // FN-4862 node-settings sync auth/ownership backstop.
      // Malformed or mismatched bearer variants must fail auth before any remote settings apply mutation.
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Missing or invalid Authorization header|Invalid apiKey/);
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
    });

    it.each([
      ["empty Authorization header", ""],
      ["wrong scheme: Basic", "Basic test-api-key-123"],
      ["wrong scheme: lowercase bearer", "bearer test-api-key-123"],
      ["Bearer with empty token", "Bearer "],
      ["Bearer with trailing whitespace token", "Bearer test-api-key-123 "],
    ])("rejects %s on POST /api/settings/auth-receive with 401", async (_name, authorization) => {
      mockListNodes.mockResolvedValue([createMockLocalNode()]);

      const res = await request(
        app,
        "POST",
        "/api/settings/auth-receive",
        JSON.stringify({
          authMaterial: { version: 1, exportedAt: "2026-05-17T00:00:00.000Z", checksum: "auth-checksum", payload: { providerAuth: {} } },
          sourceNodeId: "node-remote-001",
          timestamp: "2026-05-17T00:00:00.000Z",
        }),
        { "content-type": "application/json", Authorization: authorization },
      );

      // FN-4862 node-settings sync auth/ownership backstop.
      // Auth-receive must reject malformed bearer variants without touching auth snapshot apply/storage writes.
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Missing or invalid Authorization header|Invalid apiKey/);
      expect(mockApplyAuthMaterialSnapshot).not.toHaveBeenCalled();
      expect(mockAuthStorageSet).not.toHaveBeenCalled();
    });

    it("rejects sync-receive when sourceNodeId matches local node id but bearer is wrong", async () => {
      mockListNodes.mockResolvedValue([createMockLocalNode()]);

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({ sourceNodeId: "node-local-001", exportedAt: "2026-05-17T00:00:00.000Z", global: {}, projects: {} }),
        { "content-type": "application/json", Authorization: "Bearer wrong-token" },
      );

      // FN-4862 node-settings sync auth/ownership backstop.
      // sourceNodeId is informational and must never bypass bearer validation.
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid apiKey");
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
    });

    it("does NOT auto-trust sourceNodeId matching local node id — still requires bearer match", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);
      mockApplyRemoteSettings.mockResolvedValue({ success: true, globalCount: 0, projectCount: 0, authCount: 0 });

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({ sourceNodeId: "node-local-001", exportedAt: "2026-05-17T00:00:00.000Z", global: {}, projects: {} }),
        { "content-type": "application/json", Authorization: `Bearer ${localNode.apiKey}` },
      );

      // FN-4862 node-settings sync auth/ownership backstop.
      // Matching sourceNodeId is allowed only after valid bearer auth succeeds and reaches applyRemoteSettings.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockApplyRemoteSettings).toHaveBeenCalledTimes(1);
    });

    it("rejects a bearer that is a strict prefix of the local apiKey", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({ sourceNodeId: "node-remote-001", exportedAt: "2026-05-17T00:00:00.000Z", global: {}, projects: {} }),
        { "content-type": "application/json", Authorization: "Bearer local-api-key" },
      );

      // FN-4862 node-settings sync auth/ownership backstop.
      // Exact token equality is required so prefix matches cannot authenticate.
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid apiKey");
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
    });

    it("rejects a bearer that is a strict suffix of the local apiKey", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({ sourceNodeId: "node-remote-001", exportedAt: "2026-05-17T00:00:00.000Z", global: {}, projects: {} }),
        { "content-type": "application/json", Authorization: "Bearer key-456" },
      );

      // FN-4862 node-settings sync auth/ownership backstop.
      // Exact token equality is required so suffix matches cannot authenticate.
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid apiKey");
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
    });

    it("accepts POST /api/settings/sync-receive with correct bearer and applies remote settings", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);
      mockApplyRemoteSettings.mockResolvedValue({ success: true, globalCount: 1, projectCount: 1, authCount: 0, workflowSettingsCount: 0 });
      const payload = { sourceNodeId: "node-remote-001", exportedAt: "2026-05-17T00:00:00.000Z", global: { theme: "dark" }, projects: { kb: { model: "gpt-5" } } };

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify(payload),
        { "content-type": "application/json", Authorization: `Bearer ${localNode.apiKey}` },
      );

      // FN-4862 node-settings sync auth/ownership backstop.
      // Correct local bearer must still permit the ownership happy path and apply settings exactly once.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockApplyRemoteSettings).toHaveBeenCalledTimes(1);
      expect(mockApplyRemoteSettings).toHaveBeenCalledWith(payload);
    });

    it("accepts POST /api/settings/auth-receive with correct bearer and applies auth material", async () => {
      const localNode = createMockLocalNode();
      mockListNodes.mockResolvedValue([localNode]);
      const authPayload = {
        authMaterial: { version: 1, exportedAt: "2026-05-17T00:00:00.000Z", checksum: "auth-checksum", payload: { providerAuth: {} } },
        sourceNodeId: "node-remote-001",
        timestamp: "2026-05-17T00:00:00.000Z",
      };

      const res = await request(
        app,
        "POST",
        "/api/settings/auth-receive",
        JSON.stringify(authPayload),
        { "content-type": "application/json", Authorization: `Bearer ${localNode.apiKey}` },
      );

      // FN-4862 node-settings sync auth/ownership backstop.
      // Correct local bearer must still allow auth material import and AuthStorage write side effects.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockApplyAuthMaterialSnapshot).toHaveBeenCalledTimes(1);
      expect(mockAuthStorageSet).toHaveBeenCalled();
    });

    it("POST /api/settings/sync-receive does not echo the attempted bearer token in the 401 response body", async () => {
      mockListNodes.mockResolvedValue([createMockLocalNode()]);

      const res = await request(
        app,
        "POST",
        "/api/settings/sync-receive",
        JSON.stringify({ sourceNodeId: "node-remote-001", exportedAt: "2026-05-17T00:00:00.000Z", global: {}, projects: {} }),
        { "content-type": "application/json", Authorization: "Bearer leaked-token-should-never-appear" },
      );

      // FN-4862 node-settings sync auth/ownership backstop.
      // 401 bodies must avoid reflecting supplied bearer data to prevent credential leak-by-error-response.
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain("leaked-token-should-never-appear");
      expect(JSON.stringify(res.body)).not.toContain("Bearer ");
      expect(mockApplyRemoteSettings).not.toHaveBeenCalled();
    });
  });
});
