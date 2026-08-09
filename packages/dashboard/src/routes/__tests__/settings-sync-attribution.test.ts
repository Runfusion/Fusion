// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthMiddleware } from "../../auth-middleware.js";
import { request } from "../../test-request.js";

const core = vi.hoisted(() => ({
  CentralCore: vi.fn(),
  isMovedSettingsKey: vi.fn(() => false),
  CONFIG_CHANGED_BY_API_VERIFIED_NODE_KEY: { kind: "api", id: "http:verified-node-key" },
}));
const helpers = vi.hoisted(() => ({ fetchFromRemoteNode: vi.fn() }));
vi.mock("@fusion/core", async () => ({
  ...(await vi.importActual<typeof import("@fusion/core")>("@fusion/core")),
  ...core,
}));
vi.mock("../register-settings-sync-helpers.js", async () => ({
  ...(await vi.importActual<typeof import("../register-settings-sync-helpers.js")>("../register-settings-sync-helpers.js")),
  fetchFromRemoteNode: helpers.fetchFromRemoteNode,
}));

import { registerSettingsSyncRoutes } from "../register-settings-sync-routes.js";
import { registerSettingsSyncInboundRoutes } from "../register-settings-sync-inbound-routes.js";

function makeContext() {
  const store = {
    backendMode: false,
    getGlobalSettingsDir: vi.fn(() => "/global"),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn(async () => ({})) })),
    updateGlobalSettings: vi.fn(async () => undefined),
    getWorkflowSettingsProjectId: vi.fn(() => "project-1"),
    updateWorkflowSettingValues: vi.fn(async () => ({})),
  };
  const router = express.Router();
  const context = {
    router, store,
    emitAuthSyncAuditLog: vi.fn(),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never;
  return { router, store, context };
}

function appForPull(token?: string) {
  const { router, store, context } = makeContext();
  registerSettingsSyncRoutes(context);
  const app = express();
  app.use(express.json());
  if (token) app.use(createAuthMiddleware(token));
  app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  return { app, store };
}

function appForInbound() {
  const { router, store, context } = makeContext();
  registerSettingsSyncInboundRoutes(context);
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  return { app, store };
}

describe("settings sync revision attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    helpers.fetchFromRemoteNode.mockResolvedValue({ global: { defaultModelId: "remote" }, project: {}, workflowSettings: { "builtin:coding": { workflowStepTimeoutMs: 1 } } });
    core.CentralCore.mockImplementation(function CentralCore() {
      return {
        init: vi.fn(), close: vi.fn(), getNode: vi.fn(async () => ({ id: "remote", type: "remote" })),
        applyRemoteSettings: vi.fn(async () => ({ success: true })), updateSettingsSyncState: vi.fn(),
        listNodes: vi.fn(async () => [{ id: "local", type: "local", apiKey: "node-key" }]),
      };
    });
  });

  it("uses the daemon verification result for both pull writes", async () => {
    const { app, store } = appForPull("daemon-token");
    const response = await request(app, "POST", "/api/nodes/remote/settings/pull", JSON.stringify({}), { authorization: "Bearer daemon-token", "content-type": "application/json" });

    expect(response.status).toBe(200);
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ defaultModelId: "remote" }, { kind: "api", id: "http:verified-token" });
    expect(store.updateWorkflowSettingValues).toHaveBeenCalledWith("builtin:coding", "project-1", { workflowStepTimeoutMs: 1 }, { kind: "api", id: "http:verified-token" });
  });

  it("does not trust an arbitrary bearer header when daemon auth is inactive", async () => {
    const { app, store } = appForPull();
    const response = await request(app, "POST", "/api/nodes/remote/settings/pull", JSON.stringify({}), { authorization: "Bearer forged", "content-type": "application/json" });

    expect(response.status).toBe(200);
    expect(store.updateGlobalSettings).toHaveBeenCalledWith(expect.any(Object), { kind: "api", id: "http:unverified" });
    expect(store.updateWorkflowSettingValues).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Object), { kind: "api", id: "http:unverified" });
  });

  it("preserves the daemon-derived actor across rejected workflow-setting retries", async () => {
    helpers.fetchFromRemoteNode.mockResolvedValueOnce({
      global: {}, project: {}, workflowSettings: {
        "builtin:coding": { workflowStepScopeEnforcement: "warn", workflowStepTimeoutMs: 1 },
      },
    });
    const { app, store } = appForPull("daemon-token");
    store.updateWorkflowSettingValues
      .mockRejectedValueOnce({ rejections: [{ settingId: "workflowStepScopeEnforcement" }] })
      .mockResolvedValueOnce({ workflowStepTimeoutMs: 1 });

    const response = await request(app, "POST", "/api/nodes/remote/settings/pull", JSON.stringify({}), { authorization: "Bearer daemon-token", "content-type": "application/json" });

    expect(response.status).toBe(200);
    expect(store.updateWorkflowSettingValues).toHaveBeenCalledTimes(2);
    expect(store.updateWorkflowSettingValues.mock.calls.map(([, , , actor]) => actor)).toEqual([
      { kind: "api", id: "http:verified-token" },
      { kind: "api", id: "http:verified-token" },
    ]);
  });

  it("uses node-key provenance only after the inbound apiKey check passes", async () => {
    const { app, store } = appForInbound();
    const body = { sourceNodeId: "remote", exportedAt: "2026-08-09T00:00:00.000Z", global: { defaultModelId: "remote" }, workflowSettings: { "builtin:coding": { workflowStepTimeoutMs: 1 } } };
    const accepted = await request(app, "POST", "/api/settings/sync-receive", JSON.stringify(body), { authorization: "Bearer node-key", "content-type": "application/json" });
    const rejected = await request(app, "POST", "/api/settings/sync-receive", JSON.stringify(body), { authorization: "Bearer wrong", "content-type": "application/json" });

    expect(accepted.status).toBe(200);
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ defaultModelId: "remote" }, { kind: "api", id: "http:verified-node-key" });
    expect(store.updateWorkflowSettingValues).toHaveBeenCalledWith("builtin:coding", "project-1", { workflowStepTimeoutMs: 1 }, { kind: "api", id: "http:verified-node-key" });
    expect(rejected.status).toBe(401);
    expect(store.updateGlobalSettings).toHaveBeenCalledTimes(1);
  });

  it("preserves node-key provenance across inbound workflow-setting retries and skips empty sections", async () => {
    const { app, store } = appForInbound();
    store.updateWorkflowSettingValues
      .mockRejectedValueOnce({ rejections: [{ settingId: "workflowStepScopeEnforcement" }] })
      .mockResolvedValueOnce({ workflowStepTimeoutMs: 1 });
    const body = {
      sourceNodeId: "remote", exportedAt: "2026-08-09T00:00:00.000Z", global: {},
      workflowSettings: { "builtin:coding": { workflowStepScopeEnforcement: "warn", workflowStepTimeoutMs: 1 } },
    };

    const accepted = await request(app, "POST", "/api/settings/sync-receive", JSON.stringify(body), { authorization: "Bearer node-key", "content-type": "application/json" });
    expect(accepted.status).toBe(200);
    expect(store.updateWorkflowSettingValues).toHaveBeenCalledTimes(2);
    expect(store.updateWorkflowSettingValues.mock.calls.map(([, , , actor]) => actor)).toEqual([
      { kind: "api", id: "http:verified-node-key" },
      { kind: "api", id: "http:verified-node-key" },
    ]);

    const empty = await request(app, "POST", "/api/settings/sync-receive", JSON.stringify({ ...body, workflowSettings: {} }), { authorization: "Bearer node-key", "content-type": "application/json" });
    expect(empty.status).toBe(200);
    expect(store.updateWorkflowSettingValues).toHaveBeenCalledTimes(2);
  });
});
