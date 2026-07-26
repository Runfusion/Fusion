// @vitest-environment node

/*
FNXC:ApprovalDecisionAuthority 2026-07-26-17:10:
Negative-path coverage for POST /api/approvals/:id/decision — none existed before, which
is how an AI agent could self-approve its own destructive request: the route accepted a
client-supplied `actor` as the authorization input with shape validation only.

Invariants under test:
  - the decider recorded in the store is ALWAYS the server-derived synthetic operator
    (actorId "user" / actorType "user"), never a body-claimed identity;
  - a body actor with a non-user actorType is rejected 403;
  - a body actor matching the request's requester is rejected 403 (self-approval);
  - a requester whose actorId equals the derived operator id cannot be auto-decided;
  - with the real bearer-token middleware installed, an unauthenticated decision is 401;
  - store lifecycle races (invalid transition / expired) map to 409, unknown id to 404;
  - approving sandbox_provisioning with no registered executor is refused 409 BEFORE
    decide() (the request stays pending — no lying "approved" audit);
  - a store rejection surfaces as a 5xx error, never a silent success (fail closed).

All store access is via in-memory fakes (no DB, no network, no timers) per the AGENTS.md
slow-test rule; the bearer middleware runs in-process via the mock-socket test harness.
*/

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const approvalState = vi.hoisted(() => ({
  requests: new Map<string, Record<string, unknown>>(),
  decide: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createCoreMock } = await import("../../test/mockCoreEngine.js");
  return createCoreMock(() => importOriginal<Record<string, unknown>>(), {
    /*
    FNXC:ApprovalDecisionAuthority 2026-07-26-17:10:
    Routes construct their own ApprovalRequestStore per request, so the fake reads the
    shared hoisted state instead of instance state. AgentStore is inert — the decision
    route only touches it in resume-after-decision best-effort paths.
    */
    ApprovalRequestStore: class FakeApprovalRequestStore {
      constructor(..._args: unknown[]) {}
      async get(id: string) { return approvalState.requests.get(id); }
      async decide(id: string, status: string, input: unknown) { return approvalState.decide(id, status, input); }
      async getAuditHistory() { return []; }
      async list() { return []; }
      async findLatestByDedupeKey() { return undefined; }
    },
    AgentStore: class FakeAgentStore {
      constructor(..._args: unknown[]) {}
      async init() {}
      async getAgent() { return undefined; }
      async updateAgentState() {}
      async updateAgent() {}
    },
  });
});

import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import type { ServerOptions } from "../../server.js";
import { createAuthMiddleware } from "../../auth-middleware.js";
import { registerSandboxProvisioningExecutor } from "../register-approval-routes.js";
import { request as REQUEST } from "../../test-request.js";

const REQUEST_ID = "AR-1";

function makeApprovalRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    status: "pending",
    requester: { actorId: "agent-7", actorType: "agent", actorName: "Agent Seven" },
    requestedAt: "2026-07-26T00:00:00.000Z",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    targetAction: {
      category: "command",
      action: "run",
      summary: "Run a command",
      resourceType: "command",
      resourceId: "cmd-1",
    },
    ...overrides,
  };
}

function makeStore(): TaskStore {
  return {
    getRootDir: vi.fn(() => process.cwd()),
    getFusionDir: vi.fn(() => "/tmp/fusion-approval-route-test"),
    getAsyncLayer: vi.fn(() => ({})),
    getSettings: vi.fn(async () => ({})),
    getTask: vi.fn(async () => { throw new Error("no task in this suite"); }),
    recordRunAuditEvent: vi.fn(async () => {}),
    // Marks the store runtime-owned so project-context binding skips the plugin-MCP binder.
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
  } as unknown as TaskStore;
}

function makeLogger() {
  const warn = vi.fn();
  const logger = {
    scope: "test",
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => logger,
  };
  return { logger, warn };
}

function makeApp(options?: Partial<ServerOptions> & { authToken?: string }) {
  const store = makeStore();
  const app = express();
  if (options?.authToken) {
    app.use(createAuthMiddleware(options.authToken));
  }
  app.use(express.json());
  const { authToken: _authToken, ...serverOptions } = options ?? {};
  app.use("/api", createApiRoutes(store, serverOptions as ServerOptions));
  return { app, store };
}

async function postDecision(
  app: Parameters<typeof REQUEST>[0],
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return REQUEST(app, "POST", `/api/approvals/${REQUEST_ID}/decision`, JSON.stringify(body), {
    "content-type": "application/json",
    ...headers,
  });
}

beforeEach(() => {
  approvalState.requests.clear();
  approvalState.requests.set(REQUEST_ID, makeApprovalRequest());
  approvalState.decide.mockReset();
  approvalState.decide.mockImplementation(async (id: string, status: string, input: { actor: unknown; note?: string }) => ({
    ...makeApprovalRequest(),
    id,
    status,
    decidedAt: "2026-07-26T00:00:01.000Z",
    decidedBy: (input.actor as { actorId?: string })?.actorId,
  }));
  registerSandboxProvisioningExecutor(null);
});

describe("POST /api/approvals/:id/decision — server-derived decider", () => {
  it("records the synthetic operator when the body carries no actor", async () => {
    const { app } = makeApp();
    const res = await postDecision(app, { decision: "approve", comment: "ok" });

    expect(res.status).toBe(200);
    expect(approvalState.decide).toHaveBeenCalledTimes(1);
    expect(approvalState.decide).toHaveBeenCalledWith(REQUEST_ID, "approved", {
      actor: { actorId: "user", actorType: "user", actorName: "User" },
      note: "ok",
    });
  });

  it("keeps actorId/actorType server-derived and carries only the display name from a user body actor", async () => {
    const { app } = makeApp();
    const res = await postDecision(app, {
      decision: "approve",
      actor: { actorId: "someone-else", actorType: "user", actorName: "Alice Operator" },
    });

    expect(res.status).toBe(200);
    const [, , input] = approvalState.decide.mock.calls[0];
    expect(input.actor).toEqual({ actorId: "user", actorType: "user", actorName: "Alice Operator" });
  });

  it("rejects a forged non-user body actor with 403 and never calls decide", async () => {
    const { app } = makeApp();
    const res = await postDecision(app, {
      decision: "approve",
      actor: { actorId: "agent-7", actorType: "agent", actorName: "Agent Seven" },
    });

    expect(res.status).toBe(403);
    expect(approvalState.decide).not.toHaveBeenCalled();
  });

  it("rejects a body actor whose actorId matches the requester with 403 (self-approval claim)", async () => {
    const { app } = makeApp();
    const res = await postDecision(app, {
      decision: "approve",
      actor: { actorId: "agent-7", actorType: "user", actorName: "Totally A Human" },
    });

    expect(res.status).toBe(403);
    expect(approvalState.decide).not.toHaveBeenCalled();
  });

  it("refuses 403 when the derived operator IS the requester (requester actorId 'user')", async () => {
    approvalState.requests.set(REQUEST_ID, makeApprovalRequest({
      requester: { actorId: "user", actorType: "user", actorName: "User" },
    }));
    const { app } = makeApp();
    const res = await postDecision(app, { decision: "approve" });

    expect(res.status).toBe(403);
    expect(approvalState.decide).not.toHaveBeenCalled();
  });

  it("still rejects a malformed body actor with 400", async () => {
    const { app } = makeApp();
    const res = await postDecision(app, { decision: "approve", actor: { actorId: 42 } });

    expect(res.status).toBe(400);
    expect(approvalState.decide).not.toHaveBeenCalled();
  });
});

describe("POST /api/approvals/:id/decision — auth boundary", () => {
  it("returns 401 for an unauthenticated decision when the real bearer middleware is installed", async () => {
    const { app } = makeApp({ authToken: "test-daemon-token" });
    const res = await postDecision(app, { decision: "approve" });

    expect(res.status).toBe(401);
    expect(approvalState.decide).not.toHaveBeenCalled();
  });

  it("accepts the decision with a valid bearer token", async () => {
    const { app } = makeApp({ authToken: "test-daemon-token" });
    const res = await postDecision(app, { decision: "approve" }, { authorization: "Bearer test-daemon-token" });

    expect(res.status).toBe(200);
    expect(approvalState.decide).toHaveBeenCalledTimes(1);
  });

  it("warns loudly (but still allows) when daemon auth is disabled", async () => {
    const { logger, warn } = makeLogger();
    const { app } = makeApp({ runtimeLogger: logger as unknown as ServerOptions["runtimeLogger"], isDaemonAuthEnabled: false });
    const res = await postDecision(app, { decision: "approve" });

    expect(res.status).toBe(200);
    expect(warn.mock.calls.some(([message]) => String(message).includes("without daemon auth"))).toBe(true);
  });

  it("does not emit the local-trust warning when daemon auth is enabled", async () => {
    const { logger, warn } = makeLogger();
    const { app } = makeApp({ runtimeLogger: logger as unknown as ServerOptions["runtimeLogger"], isDaemonAuthEnabled: true });
    const res = await postDecision(app, { decision: "approve" });

    expect(res.status).toBe(200);
    expect(warn.mock.calls.some(([message]) => String(message).includes("without daemon auth"))).toBe(false);
  });
});

describe("POST /api/approvals/:id/decision — store lifecycle mapping", () => {
  it("maps an invalid-transition (replayed/already-decided) store error to 409", async () => {
    approvalState.decide.mockRejectedValue(new Error("Invalid approval request transition: approved -> approved"));
    const { app } = makeApp();
    const res = await postDecision(app, { decision: "approve" });

    expect(res.status).toBe(409);
  });

  it("maps an expired-request store error to 409", async () => {
    approvalState.decide.mockRejectedValue(new Error(`Approval request ${REQUEST_ID} has expired`));
    const { app } = makeApp();
    const res = await postDecision(app, { decision: "approve" });

    expect(res.status).toBe(409);
  });

  it("returns 404 for a nonexistent approval request", async () => {
    approvalState.requests.clear();
    const { app } = makeApp();
    const res = await postDecision(app, { decision: "approve" });

    expect(res.status).toBe(404);
    expect(approvalState.decide).not.toHaveBeenCalled();
  });

  it("fails closed with a 5xx error when the store rejects for an unknown reason", async () => {
    approvalState.decide.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const { app } = makeApp();
    const res = await postDecision(app, { decision: "approve" });

    expect(res.status).toBe(500);
    expect(res.status).not.toBe(200);
  });
});

describe("POST /api/approvals/:id/decision — sandbox provisioning honesty", () => {
  it("refuses 409 to approve sandbox_provisioning when no executor is registered, before decide()", async () => {
    approvalState.requests.set(REQUEST_ID, makeApprovalRequest({
      targetAction: {
        category: "sandbox_provisioning",
        action: "provision",
        summary: "Provision a sandbox",
        resourceType: "sandbox",
        resourceId: "sb-1",
      },
    }));
    const { app } = makeApp();
    const res = await postDecision(app, { decision: "approve" });

    expect(res.status).toBe(409);
    expect(approvalState.decide).not.toHaveBeenCalled();
  });

  it("still allows denying sandbox_provisioning without an executor", async () => {
    approvalState.requests.set(REQUEST_ID, makeApprovalRequest({
      targetAction: {
        category: "sandbox_provisioning",
        action: "provision",
        summary: "Provision a sandbox",
        resourceType: "sandbox",
        resourceId: "sb-1",
      },
      context: { backendId: "docker", operation: "provision" },
    }));
    const { app } = makeApp();
    const res = await postDecision(app, { decision: "deny" });

    expect(res.status).toBe(200);
    expect(approvalState.decide).toHaveBeenCalledWith(REQUEST_ID, "denied", expect.objectContaining({
      actor: { actorId: "user", actorType: "user", actorName: "User" },
    }));
  });
});
