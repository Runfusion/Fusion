// @vitest-environment node

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerJiraRoutes } from "../routes/register-jira.js";
import type { ApiRoutesContext } from "../routes/types.js";
import { request } from "../test-request.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function buildApp(fetchImpl: typeof fetch) {
  const store = {
    getSettings: vi.fn().mockResolvedValue({ jiraEnabled: true, jiraBaseUrl: "https://acme.atlassian.net" }),
    getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }),
    getSecretsStore: vi.fn().mockResolvedValue({
      listSecrets: vi.fn().mockResolvedValue([{ id: "secret-1", key: "JIRA_API_TOKEN" }]),
      revealSecret: vi.fn().mockResolvedValue({ plaintextValue: "test-token" }),
    }),
    updateTask: vi.fn(() => { throw new Error("derive route must be read-only"); }),
    createTask: vi.fn(() => { throw new Error("derive route must be read-only"); }),
  };
  const app = express();
  app.use(express.json());
  const ctx: ApiRoutesContext = {
    router: express.Router(),
    store: store as never,
    runtimeLogger: {} as never,
    planningLogger: {} as never,
    chatLogger: {} as never,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store as never,
    getProjectContext: async () => ({ store: store as never, engine: undefined, projectId: undefined }),
    prioritizeProjectsForCurrentDirectory: (projects) => projects,
    emitRemoteRouteDiagnostic: () => {},
    emitAuthSyncAuditLog: () => {},
    parseScopeParam: () => undefined,
    resolveAutomationStore: () => ({} as never),
    resolveRoutineStore: () => ({} as never),
    resolveRoutineRunner: () => ({} as never),
    registerDispose: () => {},
    dispose: () => {},
    rethrowAsApiError: (error) => { throw error; },
  };
  vi.stubGlobal("fetch", fetchImpl);
  registerJiraRoutes(ctx);
  app.use("/api", ctx.router);
  app.use((error: { status?: number; message: string }, _req: unknown, res: express.Response, _next: unknown) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  return { app, store };
}

afterEach(() => vi.unstubAllGlobals());

describe("JIRA branch-name route", () => {
  it("maps generic upstream failures to the declared network_error fallback without mutating tasks", async () => {
    const { app, store } = buildApp(vi.fn().mockResolvedValue(jsonResponse({}, 500)) as typeof fetch);

    const response = await request(app, "POST", "/api/jira/derive-branch-name", JSON.stringify({ issueKey: "PRD-1234" }), {
      "Content-Type": "application/json",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: false, reason: "network_error", message: "JIRA is unavailable. Try again later." });
    expect(store.createTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
