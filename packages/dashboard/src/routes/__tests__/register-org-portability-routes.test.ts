// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerOrgPortabilityRoutes } from "../register-org-portability-routes.js";

const core = vi.hoisted(() => ({
  AgentStore: vi.fn(),
  RoutineStore: vi.fn(),
  AutomationStore: vi.fn(),
  assembleOrgBundle: vi.fn(),
  materializeOrgBundle: vi.fn(),
  ConfigurationRevisionStore: vi.fn(),
}));

vi.mock("@fusion/core", () => core);

function createApp() {
  const store = {
    getAsyncLayer: vi.fn(() => ({ projectId: "project-1" })),
    getFusionDir: vi.fn(() => "/project/.fusion"),
    getRootDir: vi.fn(() => "/project"),
    rollbackConfiguration: vi.fn(),
  };
  const router = express.Router();
  registerOrgPortabilityRoutes({
    router,
    store: store as never,
    runtimeLogger: {} as never, planningLogger: {} as never, chatLogger: {} as never,
    getProjectIdFromRequest: vi.fn(() => "project-1"),
    getScopedStore: vi.fn(),
    getProjectContext: vi.fn(async () => ({ store, projectId: "project-1" })),
    prioritizeProjectsForCurrentDirectory: vi.fn(), emitRemoteRouteDiagnostic: vi.fn(), emitAuthSyncAuditLog: vi.fn(),
    parseScopeParam: vi.fn(), resolveAutomationStore: vi.fn(), resolveRoutineStore: vi.fn(), resolveRoutineRunner: vi.fn(),
    registerDispose: vi.fn(), dispose: vi.fn(), rethrowAsApiError: (error: unknown) => { throw error; },
  });
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  return { app, store };
}

describe("register-org-portability-routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    core.AgentStore.mockImplementation(function AgentStore() { return { init: vi.fn().mockResolvedValue(undefined) }; });
    core.RoutineStore.mockImplementation(function RoutineStore() { return {}; });
    core.AutomationStore.mockImplementation(function AutomationStore() { return {}; });
  });

  it("exports a scrubbed bundle and removes secret-bearing response keys", async () => {
    core.assembleOrgBundle.mockResolvedValue({
      settings: { apiKey: "leaked", nested: { daemonToken: "leaked", secretRef: "allowed-reference" } },
      routines: [{ trigger: { secret: "leaked" } }],
    });
    const { app } = createApp();
    const response = await request(app, "POST", "/api/org/export", "{}", { "Content-Type": "application/json" });

    expect(response.status).toBe(200);
    expect(response.body.bundle.settings).toEqual({ nested: { secretRef: "allowed-reference" } });
    expect(JSON.stringify(response.body)).not.toContain("leaked");
    expect(JSON.stringify(response.body)).not.toContain("apiKey");
    expect(JSON.stringify(response.body)).not.toContain("daemonToken");
  });

  it("imports a scrubbed bundle in dry-run mode", async () => {
    core.materializeOrgBundle.mockResolvedValue({ created: { agents: ["planned-agent"] } });
    const { app } = createApp();
    const response = await request(app, "POST", "/api/org/import", JSON.stringify({ bundle: { version: 1, apiKey: "nope" }, dryRun: true }), { "Content-Type": "application/json" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ dryRun: true, result: { created: { agents: ["planned-agent"] } } });
    expect(core.materializeOrgBundle).toHaveBeenCalledWith(expect.any(Object), { version: 1 }, { dryRun: true, collisionMode: undefined });
  });

  it("lists project revisions in the core's newest-first order", async () => {
    const list = vi.fn().mockResolvedValue([{ id: "new" }, { id: "old" }]);
    core.ConfigurationRevisionStore.mockImplementation(function ConfigurationRevisionStore() { return { list }; });
    const { app } = createApp();
    const response = await request(app, "GET", "/api/config/revisions");

    expect(response.status).toBe(200);
    expect(response.body.revisions.map((revision: { id: string }) => revision.id)).toEqual(["new", "old"]);
    expect(list).toHaveBeenCalledWith("project-settings", { projectId: "project-1" });
  });

  it("rolls back through the core store and returns its forward revision", async () => {
    const { app, store } = createApp();
    store.rollbackConfiguration.mockResolvedValue({ id: "forward-revision", source: "rollback" });
    const response = await request(app, "POST", "/api/config/revisions/prior/rollback", "{}", { "Content-Type": "application/json" });

    expect(response.status).toBe(200);
    expect(response.body.revision).toMatchObject({ id: "forward-revision", source: "rollback" });
    expect(store.rollbackConfiguration).toHaveBeenCalledWith("prior", { kind: "human", id: "dashboard-operator" });
  });

  it("rejects malformed imports and unsupported revision filters", async () => {
    const { app } = createApp();
    const importResponse = await request(app, "POST", "/api/org/import", JSON.stringify({ bundle: [] }), { "Content-Type": "application/json" });
    const listResponse = await request(app, "GET", "/api/config/revisions?configKind=routine");

    expect(importResponse.status).toBe(400);
    expect(listResponse.status).toBe(400);
  });
});
