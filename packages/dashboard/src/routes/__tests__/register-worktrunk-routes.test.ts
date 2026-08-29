// @vitest-environment node

/*
FNXC:ApprovalDecisionAuthority 2026-07-26-17:25:
POST /api/worktrunk/install-request used to take `req.body.actor` verbatim as the
approval-request requester snapshot, letting any HTTP caller forge who asked for the
install. Invariants under test:
  - the requester passed to requestWorktrunkInstallApproval is ALWAYS the synthetic
    operator (actorId "user" / actorType "user"), regardless of body content;
  - a user-typed body actor contributes only its advisory display actorName;
  - a body actor with a non-user actorType is rejected 403 and no approval request is
    created;
  - a malformed body actor stays 400 (pre-existing contract).
In-memory fakes only; the engine's worktrunk helpers are mocked so no binary probing,
network, or filesystem installs happen.
*/

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const worktrunkMocks = vi.hoisted(() => ({
  resolveWorktrunkBinary: vi.fn(),
  requestWorktrunkInstallApproval: vi.fn(),
}));

vi.mock("@fusion/engine", async () => {
  const { createEngineMock } = await import("../../test/mockCoreEngine.js");
  return createEngineMock({
    WORKTRUNK_INSTALL_PATH: "/tmp/fake-worktrunk/wt",
    WORKTRUNK_PINNED_RELEASE: { version: "1.0.0" },
    probeWorktrunk: vi.fn(async () => ({ version: "1.0.0" })),
    resolveWorktrunkBinary: worktrunkMocks.resolveWorktrunkBinary,
    requestWorktrunkInstallApproval: worktrunkMocks.requestWorktrunkInstallApproval,
  });
});

vi.mock("@fusion/core", async (importOriginal) => {
  const { createCoreMock } = await import("../../test/mockCoreEngine.js");
  return createCoreMock(() => importOriginal<Record<string, unknown>>(), {
    ApprovalRequestStore: class FakeApprovalRequestStore {
      constructor(..._args: unknown[]) {}
      async get() { return undefined; }
      async getAuditHistory() { return []; }
      async list() { return []; }
      async findLatestByDedupeKey() { return undefined; }
    },
  });
});

import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

function makeApp() {
  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getAsyncLayer: vi.fn(() => ({})),
    getSettings: vi.fn(async () => ({})),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app };
}

async function postInstallRequest(app: Parameters<typeof REQUEST>[0], body: Record<string, unknown>) {
  return REQUEST(app, "POST", "/api/worktrunk/install-request", JSON.stringify(body), {
    "content-type": "application/json",
  });
}

beforeEach(() => {
  worktrunkMocks.resolveWorktrunkBinary.mockReset();
  worktrunkMocks.resolveWorktrunkBinary.mockRejectedValue(new Error("worktrunk not installed"));
  worktrunkMocks.requestWorktrunkInstallApproval.mockReset();
  worktrunkMocks.requestWorktrunkInstallApproval.mockResolvedValue({ approvalRequestId: "AR-WT-1" });
});

describe("POST /api/worktrunk/install-request — server-derived requester", () => {
  it("uses the synthetic operator when the body carries no actor", async () => {
    const { app } = makeApp();
    const res = await postInstallRequest(app, {});

    expect(res.status).toBe(200);
    expect(worktrunkMocks.requestWorktrunkInstallApproval).toHaveBeenCalledTimes(1);
    expect(worktrunkMocks.requestWorktrunkInstallApproval.mock.calls[0][0].actor).toEqual({
      actorId: "user",
      actorType: "user",
      actorName: "User",
    });
  });

  it("keeps actorId/actorType server-derived and carries only the display name from a user body actor", async () => {
    const { app } = makeApp();
    const res = await postInstallRequest(app, {
      actor: { actorId: "someone-else", actorType: "user", actorName: "Alice Operator" },
    });

    expect(res.status).toBe(200);
    expect(worktrunkMocks.requestWorktrunkInstallApproval.mock.calls[0][0].actor).toEqual({
      actorId: "user",
      actorType: "user",
      actorName: "Alice Operator",
    });
  });

  it("rejects a forged non-user body actor with 403 and creates no approval request", async () => {
    const { app } = makeApp();
    const res = await postInstallRequest(app, {
      actor: { actorId: "agent-7", actorType: "agent", actorName: "Agent Seven" },
    });

    expect(res.status).toBe(403);
    expect(worktrunkMocks.requestWorktrunkInstallApproval).not.toHaveBeenCalled();
  });

  it("keeps rejecting a malformed body actor with 400", async () => {
    const { app } = makeApp();
    const res = await postInstallRequest(app, { actor: { actorId: "x" } });

    expect(res.status).toBe(400);
    expect(worktrunkMocks.requestWorktrunkInstallApproval).not.toHaveBeenCalled();
  });
});
