import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request } from "../test-request.js";

const AGENT_PERMISSIONS = [
  "tasks:assign",
  "tasks:create",
  "tasks:execute",
  "tasks:review",
  "tasks:merge",
  "tasks:delete",
  "tasks:archive",
  "agents:create",
  "agents:update",
  "agents:delete",
  "agents:view",
  "settings:read",
  "settings:update",
  "workflows:manage",
  "missions:manage",
  "automations:manage",
  "messages:send",
  "messages:read",
] as const;

type AgentCapability = "triage" | "executor" | "reviewer" | "merger" | "scheduler" | "engineer" | "custom";

type AgentRecord = {
  id: string;
  name: string;
  role: AgentCapability;
  state: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  permissions?: Record<string, boolean>;
};

const ROLE_DEFAULT_PERMISSIONS: Record<AgentCapability, string[]> = {
  triage: ["tasks:create", "agents:view", "messages:read"],
  executor: ["tasks:execute", "agents:view", "messages:read", "messages:send"],
  reviewer: ["tasks:review", "agents:view", "messages:read", "messages:send"],
  merger: ["tasks:merge", "agents:view", "messages:read"],
  scheduler: ["tasks:assign", "tasks:create", "tasks:archive", "agents:view", "automations:manage", "missions:manage", "messages:read"],
  engineer: ["tasks:execute", "tasks:review", "agents:view", "messages:read", "messages:send"],
  custom: [],
};

function normalizePermissions(raw: Record<string, boolean>): Set<string> {
  const result = new Set<string>();
  for (const [key, granted] of Object.entries(raw)) {
    if (granted && AGENT_PERMISSIONS.includes(key as (typeof AGENT_PERMISSIONS)[number])) {
      result.add(key);
    }
  }
  return result;
}

function computeMockAccessState(agent: AgentRecord) {
  const roleDefaultPermissions = new Set(ROLE_DEFAULT_PERMISSIONS[agent.role] ?? []);
  const explicitPermissions = normalizePermissions(agent.permissions ?? {});
  const resolvedPermissions = new Set(roleDefaultPermissions);
  for (const permission of explicitPermissions) {
    resolvedPermissions.add(permission);
  }

  const taskAssignSource = explicitPermissions.has("tasks:assign")
    ? "explicit_grant"
    : roleDefaultPermissions.has("tasks:assign")
      ? "role_default"
      : "denied";

  return {
    agentId: agent.id,
    canAssignTasks: resolvedPermissions.has("tasks:assign"),
    taskAssignSource,
    canCreateAgents: resolvedPermissions.has("agents:create"),
    canExecuteTasks: resolvedPermissions.has("tasks:execute"),
    canReviewTasks: resolvedPermissions.has("tasks:review"),
    canMergeTasks: resolvedPermissions.has("tasks:merge"),
    canDeleteAgents: resolvedPermissions.has("agents:delete"),
    canManageMissions: resolvedPermissions.has("missions:manage"),
    canSendMessages: resolvedPermissions.has("messages:send"),
    resolvedPermissions,
    explicitPermissions,
    roleDefaultPermissions,
  };
}

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockGetAgent = vi.fn();
const mockUpdateAgent = vi.fn();
const mockListAgents = vi.fn().mockResolvedValue([]);
const mockComputeAccessState = vi.fn((agent: AgentRecord) => computeMockAccessState(agent));
const mockIsValidPermission = vi.fn(
  (key: string) => AGENT_PERMISSIONS.includes(key as (typeof AGENT_PERMISSIONS)[number]),
);
const mockChatStoreInit = vi.fn().mockResolvedValue(undefined);

vi.mock("@fusion/core", () => {
  return {
    AgentStore: class MockAgentStore {
      init = mockInit;
      getAgent = mockGetAgent;
      updateAgent = mockUpdateAgent;
      listAgents = mockListAgents;
    },
    ChatStore: class MockChatStore {
      init = mockChatStoreInit;
    },
    computeAccessState: mockComputeAccessState,
    isValidPermission: mockIsValidPermission,
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1122-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1122-test/.fusion";
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
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-001",
    name: "Agent",
    role: "executor",
    state: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("Agent permission routes", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockListAgents.mockResolvedValue([]);

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/agents/:id/access", () => {
    it("returns executor access state", async () => {
      mockGetAgent.mockResolvedValue(makeAgent({ role: "executor" }));

      const response = await request(app, "GET", "/api/agents/agent-001/access");

      expect(response.status).toBe(200);
      expect((response.body as any).canExecuteTasks).toBe(true);
      expect((response.body as any).canAssignTasks).toBe(false);
      expect((response.body as any).taskAssignSource).toBe("denied");
    });

    it("returns scheduler access state with role_default task assignment", async () => {
      mockGetAgent.mockResolvedValue(makeAgent({ role: "scheduler" }));

      const response = await request(app, "GET", "/api/agents/agent-001/access");

      expect(response.status).toBe(200);
      expect((response.body as any).canAssignTasks).toBe(true);
      expect((response.body as any).taskAssignSource).toBe("role_default");
    });

    it("returns 404 for non-existent agent", async () => {
      mockGetAgent.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/agent-missing/access");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toBe("Agent not found");
    });

    it("serializes set fields as arrays", async () => {
      mockGetAgent.mockResolvedValue(makeAgent({ role: "executor" }));

      const response = await request(app, "GET", "/api/agents/agent-001/access");

      expect(response.status).toBe(200);
      expect(Array.isArray((response.body as any).resolvedPermissions)).toBe(true);
      expect(Array.isArray((response.body as any).explicitPermissions)).toBe(true);
      expect(Array.isArray((response.body as any).roleDefaultPermissions)).toBe(true);
      expect((response.body as any).resolvedPermissions).toContain("tasks:execute");
    });

    it("respects explicit permissions on the agent", async () => {
      mockGetAgent.mockResolvedValue(
        makeAgent({ role: "executor", permissions: { "tasks:assign": true } }),
      );

      const response = await request(app, "GET", "/api/agents/agent-001/access");

      expect(response.status).toBe(200);
      expect((response.body as any).canAssignTasks).toBe(true);
      expect((response.body as any).taskAssignSource).toBe("explicit_grant");
      expect((response.body as any).explicitPermissions).toContain("tasks:assign");
    });
  });

  describe("PATCH /api/agents/:id/permissions", () => {
    it("updates permissions with valid keys", async () => {
      mockUpdateAgent.mockResolvedValue(
        makeAgent({ permissions: { "tasks:assign": true, "messages:send": false } }),
      );

      const response = await request(
        app,
        "PATCH",
        "/api/agents/agent-001/permissions",
        JSON.stringify({ permissions: { "tasks:assign": true, "messages:send": false } }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect((response.body as any).permissions).toEqual({ "tasks:assign": true, "messages:send": false });
      expect(mockUpdateAgent).toHaveBeenCalledWith("agent-001", {
        permissions: { "tasks:assign": true, "messages:send": false },
      });
    });

    it("returns 400 for invalid permission key", async () => {
      const response = await request(
        app,
        "PATCH",
        "/api/agents/agent-001/permissions",
        JSON.stringify({ permissions: { "invalid:key": true } }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toBe("Invalid permission: invalid:key");
      expect(mockUpdateAgent).not.toHaveBeenCalled();
    });

    it("returns 400 for budget-related permission key", async () => {
      const response = await request(
        app,
        "PATCH",
        "/api/agents/agent-001/permissions",
        JSON.stringify({ permissions: { "budget:spend": true } }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toBe("Budget permissions are not supported");
      expect(mockUpdateAgent).not.toHaveBeenCalled();
    });

    it("returns 404 for non-existent agent", async () => {
      mockUpdateAgent.mockRejectedValue(new Error("Agent agent-missing not found"));

      const response = await request(
        app,
        "PATCH",
        "/api/agents/agent-missing/permissions",
        JSON.stringify({ permissions: { "tasks:assign": true } }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(404);
      expect((response.body as any).error).toContain("not found");
    });

    it("accepts empty permissions object", async () => {
      mockUpdateAgent.mockResolvedValue(makeAgent({ permissions: {} }));

      const response = await request(
        app,
        "PATCH",
        "/api/agents/agent-001/permissions",
        JSON.stringify({ permissions: {} }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect((response.body as any).permissions).toEqual({});
      expect(mockUpdateAgent).toHaveBeenCalledWith("agent-001", { permissions: {} });
    });
  });
});
