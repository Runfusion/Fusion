import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { request } from "../test-request.js";

const state = {
  requests: new Map<string, any>(),
  audits: new Map<string, any[]>(),
  runAuditEvents: [] as any[],
};

class MockApprovalRequestStore {
  constructor(_: unknown) {}
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
  list() {
    return [...state.requests.values()];
  }
}

class MockAgentStore {
  constructor(_: unknown) {}
  async init() {}
  async getAgent() { return null; }
  async updateAgentState() {}
  async updateAgent() {}
}

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<any>("@fusion/core");
  return {
    ...actual,
    ApprovalRequestStore: MockApprovalRequestStore,
    AgentStore: MockAgentStore,
  };
});

vi.mock("@fusion/engine", () => ({
  // FNXC:TestInfrastructure 2026-07-13-11:05: Missing @fusion/engine barrel exports added for mock completeness (check-mock-completeness.mjs gate).
  assertNoSecretPlaintext: vi.fn(),
  executeApprovedWorktrunkInstall: vi.fn(),
  listCliAdapterDescriptors: () => [],
  executeApprovedAgentProvisioning: vi.fn(async () => undefined),
}));

describe("sandbox provisioning approval routes", async () => {
  const routeModule = await import("../routes/register-approval-routes.js");
  const { registerApprovalRoutes, registerSandboxProvisioningExecutor } = routeModule;

  function createApp(runtimeLogger: any) {
    const router = express.Router();
    router.use(express.json());
    registerApprovalRoutes({
      router,
      runtimeLogger,
      getProjectContext: async () => ({
        store: {
          getDatabase: () => ({}),
          getFusionDir: () => "/tmp/fusion",
          getTask: async () => null,
          pauseTask: async () => undefined,
          recordRunAuditEvent: (event: any) => {
            state.runAuditEvents.push(event);
            return event;
          },
        },
        engine: undefined,
        projectId: "p1",
      }),
      rethrowAsApiError: (e: unknown) => { throw e; },
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
    const now = new Date().toISOString();
    state.runAuditEvents = [];
    state.requests = new Map([
      ["apr-sandbox", {
        id: "apr-sandbox",
        status: "pending",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" },
        targetAction: {
          category: "sandbox_provisioning",
          summary: "Install bubblewrap",
          action: "install",
          resourceType: "command",
          resourceId: "install",
          context: { backendId: "bubblewrap", operation: "install", params: {} },
        },
        taskId: "FN-1",
        runId: "run-1",
        createdAt: now,
        updatedAt: now,
        requestedAt: now,
      }],
    ]);
    state.audits = new Map();
    registerSandboxProvisioningExecutor(null);
  });

  it("approve invokes executor and emits approve audit", async () => {
    const executor = vi.fn(async () => undefined);
    registerSandboxProvisioningExecutor(executor);
    const runtimeLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const app = createApp(runtimeLogger);

    const res = await request(app, "POST", "/api/approvals/apr-sandbox/decision", JSON.stringify({ decision: "approve" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(state.runAuditEvents.at(-1)).toMatchObject({ mutationType: "sandbox:provisioning:approve", runId: "run-1" });
  });

  it("deny does not invoke executor and emits deny audit", async () => {
    const executor = vi.fn(async () => undefined);
    registerSandboxProvisioningExecutor(executor);
    const runtimeLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const app = createApp(runtimeLogger);

    const res = await request(app, "POST", "/api/approvals/apr-sandbox/decision", JSON.stringify({ decision: "deny" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(executor).not.toHaveBeenCalled();
    expect(state.runAuditEvents.at(-1)).toMatchObject({ mutationType: "sandbox:provisioning:deny", runId: "run-1" });
  });

  it("executor failure logs warning but decision succeeds", async () => {
    registerSandboxProvisioningExecutor(vi.fn(async () => {
      throw new Error("boom");
    }));
    const runtimeLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const app = createApp(runtimeLogger);

    const res = await request(app, "POST", "/api/approvals/apr-sandbox/decision", JSON.stringify({ decision: "approve" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(runtimeLogger.warn).toHaveBeenCalledWith(
      "Sandbox provisioning executor failed",
      expect.objectContaining({ requestId: "apr-sandbox" }),
    );
  });
});
