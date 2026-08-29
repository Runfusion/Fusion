// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRoutes } from "../../routes.js";
import { getProjectIdFromRequest } from "../context.js";
import { registerSecretsRoutes } from "../register-secrets-routes.js";
import { request } from "../../test-request.js";
import type { ApiRoutesContext } from "../types.js";

const secretsStore = {
  listSecrets: vi.fn(),
  createSecret: vi.fn(),
  updateSecret: vi.fn(),
  deleteSecret: vi.fn(),
  revealSecret: vi.fn(),
};

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    isSecretScope: actual.isSecretScope,
    isSecretAccessPolicy: actual.isSecretAccessPolicy,
  };
});

function createStore() {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) })),
    getRootDir: vi.fn().mockReturnValue("/tmp"),
    getFusionDir: vi.fn().mockReturnValue("/tmp/.fusion"),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    getMissionStore: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getSecretsStore: vi.fn().mockResolvedValue(secretsStore),
    /*
    FNXC:PluginMcpServers 2026-07-24-01:25:
    FN-8491 (3cd023fa4) binds a project-scoped plugin-MCP provider on every getProjectContext.
    Exposing getProjectScopedPluginMcpServers marks this mock as runtime-owned so the binder
    short-circuits instead of calling getPluginStore().
    */
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  } as any;
}

function app() {
  const store = createStore();
  const server = express();
  server.use(express.json());
  // Launch engine is deliberately fallback-capable: explicit project ids must select
  // this intentional context, while missing ids are rejected before it is touched.
  server.use("/api", createApiRoutes(store, {
    engine: { getProjectId: () => "proj_A", getTaskStore: () => store },
  } as any));
  return server;
}

function scopedSecretsApp() {
  const projectASecrets = { ...secretsStore, listSecrets: vi.fn(), createSecret: vi.fn(), updateSecret: vi.fn(), deleteSecret: vi.fn(), revealSecret: vi.fn() };
  const projectBSecrets = { ...secretsStore, listSecrets: vi.fn(), createSecret: vi.fn(), updateSecret: vi.fn(), deleteSecret: vi.fn(), revealSecret: vi.fn() };
  const projectAStore = { getSecretsStore: vi.fn(() => projectASecrets) };
  const projectBStore = { getSecretsStore: vi.fn(() => projectBSecrets) };
  const getProjectContext = vi.fn(async (req: express.Request) => {
    const projectId = getProjectIdFromRequest(req);
    // A call without explicit identity models the dangerous launch fallback this route must never reach.
    if (!projectId) return { projectId: "local-launch-fallback", engine: undefined, store: { getSecretsStore: vi.fn() } };
    return { projectId, engine: undefined, store: projectId === "proj_A" ? projectAStore : projectBStore };
  });
  const router = express.Router();
  const logger = { child: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  logger.child.mockReturnValue(logger);

  registerSecretsRoutes({
    router,
    runtimeLogger: logger,
    getProjectIdFromRequest,
    getProjectContext,
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as unknown as ApiRoutesContext);

  const server = express();
  server.use(express.json());
  server.use("/api", router);
  server.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message ?? "Internal server error" });
  });
  return { server, getProjectContext, projectASecrets, projectBSecrets, projectAStore, projectBStore };
}

describe("register-secrets-routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secretsStore.createSecret.mockResolvedValue({ id: "sec_1" });
    secretsStore.updateSecret.mockResolvedValue({ id: "sec_1" });
  });

  it.each([
    ["GET", "/api/secrets"],
    ["GET", "/api/secrets/sync-passphrase"],
    ["PUT", "/api/secrets/sync-passphrase"],
    ["DELETE", "/api/secrets/sync-passphrase"],
    ["POST", "/api/secrets"],
    ["PATCH", "/api/secrets/project/sec_1"],
    ["DELETE", "/api/secrets/project/sec_1"],
    ["POST", "/api/secrets/project/sec_1/reveal"],
  ])("rejects missing or blank project identity for %s %s before launch fallback store access", async (method, path) => {
    /*
    FNXC:Secrets 2026-08-05-22:08:
    Every secrets endpoint must reject missing, empty, and whitespace-only identity before the launch-capable context resolver runs. Testing every shape prevents a query parser edge case from silently reopening the fallback partition.
    */
    for (const suffix of ["", "?projectId=", "?projectId=%20%20%20"]) {
      const res = await request(app(), method, `${path}${suffix}`, method === "PUT" || method === "POST" || method === "PATCH" ? JSON.stringify({ scope: "project", key: "K", value: "v" }) : undefined, {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(400);
      expect(String((res.body as any).error)).toContain("projectId is required");
    }
    expect(secretsStore.listSecrets).not.toHaveBeenCalled();
    expect(secretsStore.createSecret).not.toHaveBeenCalled();
    expect(secretsStore.updateSecret).not.toHaveBeenCalled();
    expect(secretsStore.deleteSecret).not.toHaveBeenCalled();
    expect(secretsStore.revealSecret).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/secrets"],
    ["GET", "/api/secrets/sync-passphrase"],
    ["PUT", "/api/secrets/sync-passphrase"],
    ["DELETE", "/api/secrets/sync-passphrase"],
    ["POST", "/api/secrets"],
    ["PATCH", "/api/secrets/project/sec_1"],
    ["DELETE", "/api/secrets/project/sec_1"],
    ["POST", "/api/secrets/project/sec_1/reveal"],
  ])("fails closed before fallback-capable context resolution for %s %s", async (method, path) => {
    /*
    FNXC:Secrets 2026-08-05-22:28:
    The route-local harness makes launch fallback observable. Missing, empty, and whitespace-only identities must return 400 without calling getProjectContext, so no fallback store can list, mutate, reveal, or configure secrets.
    */
    const harness = scopedSecretsApp();
    for (const suffix of ["", "?projectId=", "?projectId=%20%20%20"]) {
      const res = await request(
        harness.server,
        method,
        `${path}${suffix}`,
        method === "PUT" || method === "POST" || method === "PATCH" ? JSON.stringify({ scope: "project", key: "K", value: "v" }) : undefined,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe("projectId is required");
    }
    expect(harness.getProjectContext).not.toHaveBeenCalled();
    expect(harness.projectAStore.getSecretsStore).not.toHaveBeenCalled();
    expect(harness.projectBStore.getSecretsStore).not.toHaveBeenCalled();
  });

  it("selects explicit project stores while global rows remain shared", async () => {
    const harness = scopedSecretsApp();
    const sharedGlobal = { id: "global-1", scope: "global", key: "SHARED" };
    const projectAOnly = { id: "a-1", scope: "project", key: "A_ONLY" };
    const projectBOnly = { id: "b-1", scope: "project", key: "B_ONLY" };
    harness.projectASecrets.listSecrets.mockResolvedValue([projectAOnly, sharedGlobal]);
    harness.projectBSecrets.listSecrets.mockResolvedValue([projectBOnly, sharedGlobal]);
    harness.projectASecrets.createSecret.mockResolvedValue(sharedGlobal);

    const created = await request(harness.server, "POST", "/api/secrets?projectId=proj_A", JSON.stringify({ scope: "global", key: "SHARED", value: "secret" }), { "Content-Type": "application/json" });
    expect(created.status).toBe(201);
    expect(harness.getProjectContext).toHaveBeenCalledTimes(1);
    expect(harness.projectAStore.getSecretsStore).toHaveBeenCalledTimes(1);
    expect(harness.projectBStore.getSecretsStore).not.toHaveBeenCalled();
    expect(harness.projectASecrets.createSecret).toHaveBeenCalledWith(expect.objectContaining({ scope: "global", key: "SHARED" }));

    const listedA = await request(harness.server, "GET", "/api/secrets?projectId=proj_A");
    const listedB = await request(harness.server, "GET", "/api/secrets?projectId=proj_B");
    expect(listedA.status).toBe(200);
    expect(listedB.status).toBe(200);
    expect((listedA.body as { secrets: Array<{ key: string }> }).secrets.map((secret) => secret.key)).toEqual(["A_ONLY", "SHARED"]);
    expect((listedB.body as { secrets: Array<{ key: string }> }).secrets.map((secret) => secret.key)).toEqual(["B_ONLY", "SHARED"]);
    expect(harness.projectAStore.getSecretsStore).toHaveBeenCalledTimes(2);
    expect(harness.projectBStore.getSecretsStore).toHaveBeenCalledTimes(1);
  });

  it("POST /api/secrets rejects non-string key", async () => {
    const res = await request(app(), "POST", "/api/secrets?projectId=proj_A", JSON.stringify({ scope: "project", key: 123, value: "v" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(String((res.body as any).error)).toContain("key must be a non-empty string");
  });

  it("POST /api/secrets rejects non-string value", async () => {
    const res = await request(app(), "POST", "/api/secrets?projectId=proj_A", JSON.stringify({ scope: "project", key: "K", value: 123 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(String((res.body as any).error)).toContain("value must be a string");
  });

  it("POST /api/secrets rejects invalid scope", async () => {
    const res = await request(app(), "POST", "/api/secrets?projectId=proj_A", JSON.stringify({ scope: "local", key: "K", value: "v" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(String((res.body as any).error)).toContain("scope must be 'project' or 'global'");
  });

  it("POST /api/secrets rejects invalid accessPolicy", async () => {
    const res = await request(
      app(),
      "POST",
      "/api/secrets?projectId=proj_A",
      JSON.stringify({ scope: "project", key: "K", value: "v", accessPolicy: "banana" }),
      {
        "Content-Type": "application/json",
      },
    );

    expect(res.status).toBe(400);
    expect(String((res.body as any).error)).toContain("accessPolicy must be one of: auto, prompt, deny");
  });

  it("POST /api/secrets accepts valid payload and passes narrowed values", async () => {
    const res = await request(
      app(),
      "POST",
      "/api/secrets?projectId=proj_A",
      JSON.stringify({ scope: "global", key: "MY_KEY", value: "secret", accessPolicy: "deny" }),
      {
        "Content-Type": "application/json",
      },
    );

    expect(res.status).toBe(201);
    expect(secretsStore.createSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "global",
        key: "MY_KEY",
        plaintextValue: "secret",
        accessPolicy: "deny",
      }),
    );
  });

  it("PATCH /api/secrets/:scope/:id rejects invalid accessPolicy", async () => {
    const res = await request(
      app(),
      "PATCH",
      "/api/secrets/project/sec_1?projectId=proj_A",
      JSON.stringify({ accessPolicy: "banana" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(String((res.body as any).error)).toContain("accessPolicy must be one of: auto, prompt, deny");
  });

  it("PATCH /api/secrets/:scope/:id allows null accessPolicy passthrough", async () => {
    const res = await request(
      app(),
      "PATCH",
      "/api/secrets/project/sec_1?projectId=proj_A",
      JSON.stringify({ accessPolicy: null }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(secretsStore.updateSecret).toHaveBeenCalledWith("sec_1", "project", { accessPolicy: null });
  });
});
