import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { get, request } from "../test-request.js";

const state = {
  requests: new Map<string, any>(),
  audits: new Map<string, any[]>(),
  task: { id: "FN-1", paused: true, pausedByAgentId: "agent-1" } as any,
  agent: { id: "agent-1", state: "paused", pauseReason: "awaiting-approval" },
  runAuditEvents: [] as any[],
  pauseTaskCalls: [] as Array<{ id: string; paused: boolean }>,
  provisionedAgents: new Set<string>(),
};

class MockApprovalRequestStore {
  constructor(_: unknown) {}
  list(input: any = {}) {
    let rows = [...state.requests.values()];
    if (input.status) rows = rows.filter((r) => r.status === input.status);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
  }
  get(id: string) {
    return state.requests.get(id) ?? null;
  }
  decide(id: string, status: "approved" | "denied", input?: { actor?: any; note?: string }) {
    const req = state.requests.get(id);
    if (!req) throw new Error("Approval request not found");
    if (req.status !== "pending") throw new Error(`Invalid approval request transition: ${req.status} -> ${status}`);
    req.status = status;
    req.decidedAt = new Date().toISOString();
    req.updatedAt = req.decidedAt;
    state.audits.set(id, [...(state.audits.get(id) ?? []), {
      id: `evt-${status}`,
      eventType: status,
      actor: input?.actor ?? { actorId: "user", actorType: "user", actorName: "User" },
      note: input?.note,
      createdAt: req.decidedAt,
    }]);
    return req;
  }
  getAuditHistory(id: string) {
    return state.audits.get(id) ?? [];
  }
}

const updateAgent = vi.fn(async (_id: string, updates: any) => ({ ...state.agent, ...updates }));

class MockAgentStore {
  constructor(_: unknown) {}
  async init() {}
  async getAgent(id: string) {
    return id === state.agent.id ? state.agent : null;
  }
  async updateAgentState(id: string, nextState: string) {
    if (id === state.agent.id) state.agent = { ...state.agent, state: nextState };
  }
  async updateAgent(id: string, updates: any) {
    if (id === state.agent.id) state.agent = { ...state.agent, ...updates };
    return updateAgent(id, updates);
  }
}

const executeApprovedAgentProvisioning = vi.fn(async (request: any) => {
  const tool = request?.targetAction?.context?.tool;
  if (!tool) throw new Error("Malformed agent provisioning request: missing tool");
  if (tool === "fn_agent_create") {
    const id = String(request?.targetAction?.context?.params?.name ?? "created-agent");
    state.provisionedAgents.add(id);
    return { id };
  }
  if (tool === "fn_agent_delete") {
    const id = String(request?.targetAction?.resourceId ?? "");
    state.provisionedAgents.delete(id);
    return { deletedId: id };
  }
  throw new Error(`Unsupported provisioning tool: ${tool}`);
});

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  ApprovalRequestStore: MockApprovalRequestStore,
  AgentStore: MockAgentStore,
}));

const executeApprovedWorktrunkInstall = vi.fn(async () => ({ binaryPath: "~/.fusion/bin/wt", source: "installed-release" }));

vi.mock("@fusion/engine", () => ({
  // FNXC:TestInfrastructure 2026-07-13-11:05: Missing @fusion/engine barrel exports added for mock completeness (check-mock-completeness.mjs gate).
  assertNoSecretPlaintext: vi.fn(),
  executeApprovedAgentProvisioning: vi.fn(),
  executeApprovedWorktrunkInstall: vi.fn(),
  listCliAdapterDescriptors: () => [],
  executeApprovedAgentProvisioning,
  executeApprovedWorktrunkInstall,
}));

describe("approval routes", async () => {
  const { registerApprovalRoutes } = await import("../routes/register-approval-routes.js");

  function createApp() {
    const router = express.Router();
    router.use(express.json());
    registerApprovalRoutes({
      router,
      runtimeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
      getProjectContext: async () => ({
        store: {
          getDatabase: () => ({}),
          getFusionDir: () => "/tmp/fusion",
          getTask: async () => state.task,
          getSettings: async () => ({ worktrunk: {} }),
          pauseTask: async (id: string, paused: boolean) => {
            state.pauseTaskCalls.push({ id, paused });
            state.task = { ...state.task, paused, pausedByAgentId: paused ? state.task.pausedByAgentId : undefined };
          },
          recordRunAuditEvent: (event: any) => {
            state.runAuditEvents.push(event);
            return event;
          },
        },
        engine: undefined,
        projectId: "p1",
      }),
      rethrowAsApiError: (e: unknown) => {
        throw e;
      },
    } as any);
    const app = express();
    app.use("/api", router);
    app.use((err: any, _req: any, res: any, _next: any) => {
      const status = err?.statusCode ?? 500;
      res.status(status).json({ error: err?.message ?? String(err) });
    });
    return app;
  }

  beforeEach(() => {
    updateAgent.mockClear();
    const now = new Date().toISOString();
    executeApprovedAgentProvisioning.mockClear();
    executeApprovedWorktrunkInstall.mockClear();
    state.runAuditEvents = [];
    state.pauseTaskCalls = [];
    state.provisionedAgents = new Set(["target-1"]);
    state.task = { id: "FN-1", paused: true, pausedByAgentId: "agent-1" };
    state.agent = { id: "agent-1", state: "paused", pauseReason: "awaiting-approval" };
    state.requests = new Map([
      ["apr-1", {
        id: "apr-1",
        status: "pending",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" },
        targetAction: { category: "command_execution", summary: "Run command", action: "bash", resourceType: "command", resourceId: "cmd-1" },
        taskId: "FN-1",
        createdAt: now,
        updatedAt: now,
        requestedAt: now,
      }],
      ["apr-2", {
        id: "apr-2",
        status: "denied",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" },
        targetAction: { category: "network_api", summary: "Fetch URL", action: "web_fetch", resourceType: "url", resourceId: "https://example.com" },
        taskId: "FN-1",
        createdAt: now,
        updatedAt: now,
        requestedAt: now,
      }],
      ["apr-3", {
        id: "apr-3",
        status: "pending",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" },
        targetAction: {
          category: "agent_provisioning",
          summary: "Create provisioned agent",
          action: "create",
          resourceType: "agent",
          resourceId: "",
          context: { tool: "fn_agent_create", params: { name: "created-agent", role: "executor" } },
        },
        taskId: "FN-1",
        runId: "run-1",
        createdAt: now,
        updatedAt: now,
        requestedAt: now,
      }],
      ["apr-4", {
        id: "apr-4",
        status: "pending",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" },
        targetAction: {
          category: "agent_provisioning",
          summary: "Delete provisioned agent",
          action: "delete",
          resourceType: "agent",
          resourceId: "target-1",
          context: { tool: "fn_agent_delete", params: { agent_id: "target-1" } },
        },
        taskId: "FN-1",
        runId: "run-2",
        createdAt: now,
        updatedAt: now,
        requestedAt: now,
      }],
      ["apr-5", {
        id: "apr-5",
        status: "pending",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" },
        targetAction: {
          category: "agent_provisioning",
          summary: "Malformed",
          action: "create",
          resourceType: "agent",
          resourceId: "",
          context: {},
        },
        taskId: "FN-1",
        runId: "run-3",
        createdAt: now,
        updatedAt: now,
        requestedAt: now,
      }],
      ["apr-6", {
        id: "apr-6",
        status: "pending",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" },
        targetAction: {
          category: "network_api",
          summary: "Install worktrunk",
          action: "worktrunk_install",
          resourceType: "binary",
          resourceId: "~/.fusion/bin/wt",
        },
        taskId: "FN-1",
        runId: "run-4",
        createdAt: now,
        updatedAt: now,
        requestedAt: now,
      }],
    ]);
    state.audits = new Map([
      ["apr-1", [{ id: "evt-created", eventType: "created", actor: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" }, createdAt: now }]],
      ["apr-2", [{ id: "evt-denied", eventType: "denied", actor: { actorId: "dashboard", actorType: "user", actorName: "User" }, createdAt: now }]],
      ["apr-6", [{ id: "evt-created-6", eventType: "created", actor: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" }, createdAt: now }]],
    ]);
  });

  it("lists with status filtering and pendingCount", async () => {
    const app = createApp();
    const res = await get(app, "/api/approvals?status=pending");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.pendingCount).toBe(5);
    expect(res.body.requests).toHaveLength(5);
    expect(res.body.requests[0]).toMatchObject({
      id: "apr-1",
      actionCategory: "command_execution",
      actionSummary: "Run command",
      agentId: "agent-1",
    });
  });

  it("returns detail with history", async () => {
    const app = createApp();
    const res = await get(app, "/api/approvals/apr-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("apr-1");
    expect(res.body.history).toHaveLength(1);
    expect(res.body.targetAction.summary).toBe("Run command");
  });

  it("returns 404 for missing request", async () => {
    const app = createApp();
    const res = await get(app, "/api/approvals/missing");
    expect(res.status).toBe(404);
  });

  it("decides approval and unpauses task/agent", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-1/decision",
      JSON.stringify({ decision: "approve", comment: "looks good" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.history.at(-1)?.eventType).toBe("approved");
    expect(res.body.history.at(-1)?.note).toBe("looks good");
    expect(state.task.paused).toBe(false);
    expect(updateAgent).toHaveBeenCalledWith("agent-1", { pauseReason: undefined });
  });

  it("does not unpause user-paused tasks after approval decision", async () => {
    state.task = { id: "FN-1", paused: true, pausedByAgentId: "agent-1", userPaused: true };
    const app = createApp();

    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-1/decision",
      JSON.stringify({ decision: "approve" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(state.task.paused).toBe(true);
    expect(state.task.userPaused).toBe(true);
    expect(state.pauseTaskCalls).not.toContainEqual({ id: "FN-1", paused: false });
    expect(updateAgent).toHaveBeenCalledWith("agent-1", { pauseReason: undefined });
  });

  it("supports deny decision", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-1/decision",
      JSON.stringify({ decision: "deny" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("denied");
    expect(state.task.paused).toBe(false);
    expect(state.pauseTaskCalls).toEqual([{ id: "FN-1", paused: false }]);
    expect(updateAgent).toHaveBeenCalledWith("agent-1", { pauseReason: undefined });
  });

  it("approves provisioning create and records audit", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-3/decision",
      JSON.stringify({ decision: "approve" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(executeApprovedAgentProvisioning).toHaveBeenCalledTimes(1);
    expect(state.provisionedAgents.has("created-agent")).toBe(true);
    expect(state.runAuditEvents.at(-1)).toMatchObject({ mutationType: "agent:create:approved", runId: "run-1" });
    expect(state.task.paused).toBe(false);
  });

  it("denies provisioning create without execution and records denied audit", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-3/decision",
      JSON.stringify({ decision: "deny" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(executeApprovedAgentProvisioning).not.toHaveBeenCalled();
    expect(state.provisionedAgents.has("created-agent")).toBe(false);
    expect(state.runAuditEvents.at(-1)).toMatchObject({ mutationType: "agent:create:denied", runId: "run-1" });
  });

  it("approves provisioning delete and records audit", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-4/decision",
      JSON.stringify({ decision: "approve" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(state.provisionedAgents.has("target-1")).toBe(false);
    expect(state.runAuditEvents.at(-1)).toMatchObject({ mutationType: "agent:delete:approved", runId: "run-2" });
  });

  it("denies provisioning delete without execution and records denied audit", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-4/decision",
      JSON.stringify({ decision: "deny" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(executeApprovedAgentProvisioning).not.toHaveBeenCalled();
    expect(state.provisionedAgents.has("target-1")).toBe(true);
    expect(state.runAuditEvents.at(-1)).toMatchObject({ mutationType: "agent:delete:denied", runId: "run-2" });
  });

  it("returns 500 for malformed provisioning request context", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-5/decision",
      JSON.stringify({ decision: "approve" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Malformed agent provisioning request");
  });

  it("invokes worktrunk installer on approve for worktrunk_install approvals", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-6/decision",
      JSON.stringify({ decision: "approve" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(executeApprovedWorktrunkInstall).toHaveBeenCalledTimes(1);
  });

  it("does not invoke worktrunk installer on deny for worktrunk_install approvals", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-6/decision",
      JSON.stringify({ decision: "deny" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(executeApprovedWorktrunkInstall).not.toHaveBeenCalled();
  });

  it("returns 409 for invalid transition", async () => {
    const app = createApp();
    const res = await request(
      app,
      "POST",
      "/api/approvals/apr-2/decision",
      JSON.stringify({ decision: "approve" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(409);
  });
});
