import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { get, request } from "../test-request.js";

const state = {
  installed: false,
  pendingApprovalId: "apr-worktrunk",
  requests: new Map<string, any>(),
};

const requestWorktrunkInstallApproval = vi.fn(async () => ({ approvalRequestId: state.pendingApprovalId, status: "pending" as const }));
const resolveWorktrunkBinary = vi.fn(async () => {
  if (!state.installed) throw new Error("missing");
  return { binaryPath: "~/.fusion/bin/wt", source: "cached" as const };
});
const probeWorktrunk = vi.fn(async () => ({ ok: true, version: "0.4.2" }));

class MockApprovalRequestStore {
  constructor(_: unknown) {}
  findLatestByDedupeKey() {
    return state.requests.get(state.pendingApprovalId) ?? null;
  }
  get(id: string) {
    return state.requests.get(id) ?? null;
  }
}

vi.mock("@fusion/engine", () => ({
  WORKTRUNK_INSTALL_PATH: "~/.fusion/bin/wt",
  WORKTRUNK_PINNED_RELEASE: {
    source: "upstream-pending-verification",
    version: null,
    verifiedAt: null,
    assets: {},
  },
  requestWorktrunkInstallApproval,
  resolveWorktrunkBinary,
  probeWorktrunk,
}));

vi.mock("@fusion/core", async (orig) => {
  const actual = await orig<any>();
  return { ...actual, ApprovalRequestStore: MockApprovalRequestStore };
});

describe("worktrunk routes", async () => {
  const { registerWorktrunkRoutes } = await import("../routes/register-worktrunk-routes.js");

  function createApp() {
    const router = express.Router();
    router.use(express.json());
    registerWorktrunkRoutes({
      router,
      getProjectContext: async () => ({
        store: {
          getDatabase: () => ({}),
          getSettings: async () => ({ worktrunk: { enabled: true, onFailure: "fail" } }),
        },
        projectId: "p1",
        engine: undefined,
      }),
      rethrowAsApiError: (e: unknown) => {
        throw e;
      },
    } as any);
    const app = express();
    app.use("/api", router);
    return app;
  }

  beforeEach(() => {
    state.installed = false;
    state.requests = new Map();
    requestWorktrunkInstallApproval.mockClear();
    resolveWorktrunkBinary.mockClear();
    probeWorktrunk.mockClear();
  });

  it("returns installed from status when binary exists", async () => {
    state.installed = true;
    const app = createApp();
    const res = await get(app, "/api/worktrunk/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "installed",
      version: "0.4.2",
      installPath: "~/.fusion/bin/wt",
    });
  });

  it("returns pending-approval from status when pending request exists", async () => {
    state.requests.set("apr-worktrunk", { id: "apr-worktrunk", status: "pending" });
    const app = createApp();
    const res = await get(app, "/api/worktrunk/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "pending-approval",
      pendingApprovalId: "apr-worktrunk",
      installPath: "~/.fusion/bin/wt",
    });
  });

  it("creates install request when missing", async () => {
    state.requests.set("apr-worktrunk", {
      id: "apr-worktrunk",
      status: "pending",
      requester: { actorId: "user", actorType: "user", actorName: "User" },
      targetAction: { category: "network_api", summary: "Install", action: "worktrunk_install", resourceType: "binary", resourceId: "x" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      requestedAt: new Date().toISOString(),
    });
    const app = createApp();
    const res = await request(app, "POST", "/api/worktrunk/install-request", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending-approval");
    expect(requestWorktrunkInstallApproval).toHaveBeenCalledTimes(1);
  });

  it("returns pending version label for installed POST route fallback", async () => {
    state.installed = true;
    probeWorktrunk.mockResolvedValueOnce({ ok: true, version: undefined });
    const app = createApp();
    const res = await request(app, "POST", "/api/worktrunk/install-request", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "installed",
      installPath: "~/.fusion/bin/wt",
      version: "pending",
    });
  });
});
