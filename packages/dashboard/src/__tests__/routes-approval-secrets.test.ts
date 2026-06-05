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
    req.status = status;
    req.decidedAt = new Date().toISOString();
    req.updatedAt = req.decidedAt;
    state.audits.set(id, [...(state.audits.get(id) ?? []), {
      id: `evt-${status}`,
      eventType: status,
      actor: input?.actor ?? { actorId: "user", actorType: "user", actorName: "User" },
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

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()), ApprovalRequestStore: MockApprovalRequestStore, AgentStore: class { async init() {} async getAgent() { return null; } } }));
vi.mock("@fusion/engine", () => ({
  executeApprovedAgentProvisioning: vi.fn(),
  executeApprovedWorktrunkInstall: vi.fn(),
  assertNoSecretPlaintext: (metadata?: Record<string, unknown>) => {
    if (!metadata) return;
    for (const key of ["plaintextValue", "value", "ciphertext", "nonce", "decrypted"]) {
      if (Object.prototype.hasOwnProperty.call(metadata, key)) {
        throw new Error("secret audit metadata may not include plaintext fields");
      }
    }
  },
}));

describe("approval routes secrets audit", async () => {
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
          getTask: async () => null,
          pauseTask: async () => {},
          recordRunAuditEvent: (event: any) => state.runAuditEvents.push(event),
        },
        engine: undefined,
        projectId: "p1",
      }),
      rethrowAsApiError: (e: unknown) => { throw e; },
    } as any);
    const app = express();
    app.use("/api", router);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.statusCode ?? 500).json({ error: err?.message ?? String(err) }));
    return app;
  }

  beforeEach(() => {
    state.runAuditEvents = [];
    const now = new Date().toISOString();
    state.requests = new Map([
      ["apr-secret", {
        id: "apr-secret",
        status: "pending",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" },
        targetAction: {
          category: "secrets_access",
          summary: "Read secret",
          action: "read",
          resourceType: "secret",
          resourceId: "project:API_KEY",
          context: { key: "API_KEY", scope: "project", policySource: "secret" },
        },
        taskId: "FN-1",
        runId: "run-1",
        createdAt: now,
        updatedAt: now,
        requestedAt: now,
      }],
    ]);
    state.audits = new Map([["apr-secret", [{ id: "evt-created", eventType: "created", actor: { actorId: "agent-1", actorType: "agent", actorName: "Agent 1" }, createdAt: now }]]]);
  });

  it("emits secret:approval-granted for approved secrets_access", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/approvals/apr-secret/decision", JSON.stringify({ decision: "approve" }), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    const event = state.runAuditEvents.at(-1);
    expect(event).toMatchObject({ mutationType: "secret:approval-granted", domain: "filesystem", target: "project:API_KEY" });
  });

  it("emits secret:approval-denied for denied secrets_access", async () => {
    const app = createApp();
    const res = await request(app, "POST", "/api/approvals/apr-secret/decision", JSON.stringify({ decision: "deny" }), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    const event = state.runAuditEvents.at(-1);
    expect(event).toMatchObject({ mutationType: "secret:approval-denied", domain: "filesystem", target: "project:API_KEY" });
  });

  it("does not include plaintext-like metadata fields", async () => {
    const app = createApp();
    await request(app, "POST", "/api/approvals/apr-secret/decision", JSON.stringify({ decision: "approve" }), { "content-type": "application/json" });
    const metadata = state.runAuditEvents.at(-1)?.metadata;
    expect(metadata).toMatchObject({ approvalRequestId: "apr-secret", key: "API_KEY", scope: "project", policySource: "secret" });
    for (const key of ["plaintextValue", "value", "ciphertext", "nonce", "decrypted"]) {
      expect(metadata).not.toHaveProperty(key);
    }
  });
});
