// @vitest-environment node

import express from "express";
import { Router } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request as performRequest } from "../../test-request.js";
import { rethrowAsApiError } from "../../api-error.js";
import { registerCliAgentSettingsRoutes } from "../cli-agent-settings.js";
import type { ApiRoutesContext } from "../types.js";

/**
 * Minimal fake TaskStore covering the methods the route touches. Global settings
 * (`cliAgents`) and project autonomy approvals live in-memory; `getSettings`
 * returns the merged view (global ∪ project) the route reads from.
 */
function makeFakeStore() {
  const state = {
    cliAgents: {} as Record<string, unknown>,
    approvedCliAutonomyAdapters: [] as string[],
  };
  return {
    state,
    async getSettings() {
      return {
        cliAgents: state.cliAgents,
        approvedCliAutonomyAdapters: [...state.approvedCliAutonomyAdapters],
      };
    },
    async updateGlobalSettings(patch: { cliAgents?: Record<string, unknown> }) {
      if (patch.cliAgents) state.cliAgents = patch.cliAgents;
      return state;
    },
    async isCliAutonomyApproved(adapterId: string) {
      return state.approvedCliAutonomyAdapters.includes(adapterId);
    },
    async approveCliAutonomy(adapterId: string) {
      if (!state.approvedCliAutonomyAdapters.includes(adapterId)) {
        state.approvedCliAutonomyAdapters.push(adapterId);
      }
    },
    async revokeCliAutonomy(adapterId: string) {
      state.approvedCliAutonomyAdapters = state.approvedCliAutonomyAdapters.filter(
        (a) => a !== adapterId,
      );
    },
  };
}

function mount(store: ReturnType<typeof makeFakeStore>) {
  const router = Router();
  router.use(express.json());
  const ctx = {
    router,
    rethrowAsApiError,
    getScopedStore: async () => store as never,
    getProjectContext: async () => ({ store: store as never, engine: undefined, projectId: "p1" }),
  } as unknown as ApiRoutesContext;
  registerCliAgentSettingsRoutes(ctx);

  const app = express();
  app.use("/api", router);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? err?.status ?? 500).json({ error: err?.message ?? String(err) });
  });
  return app;
}

const JSON_HEADERS = { "content-type": "application/json", host: "127.0.0.1" };

describe("cli-agent-settings routes (U15)", () => {
  let store: ReturnType<typeof makeFakeStore>;
  let app: express.Express;

  beforeEach(() => {
    store = makeFakeStore();
    app = mount(store);
  });

  afterEach(() => {});

  it("GET /api/cli-agents lists adapter descriptors with tier labels", async () => {
    const res = await performRequest(app, "GET", "/api/cli-agents", undefined, JSON_HEADERS);
    expect(res.status).toBe(200);
    const ids = res.body.adapters.map((a: { id: string }) => a.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("generic");
    const claude = res.body.adapters.find((a: { id: string }) => a.id === "claude-code");
    expect(claude.tier).toBe("native");
    const generic = res.body.adapters.find((a: { id: string }) => a.id === "generic");
    expect(generic.tier).toBe("generic");
  });

  it("PUT /api/cli-agents/settings persists a sanitized adapter config", async () => {
    const res = await performRequest(
      app,
      "PUT",
      "/api/cli-agents/settings",
      JSON.stringify({
        adapterId: "codex",
        config: { extraArgs: ["--model=gpt"], autonomyMode: "garbage", bogus: 1 },
      }),
      JSON_HEADERS,
    );
    expect(res.status).toBe(200);
    // autonomyMode "garbage" + bogus field dropped at the core write boundary.
    expect(res.body.cliAgents).toEqual({ codex: { extraArgs: ["--model=gpt"] } });
    expect(store.state.cliAgents).toEqual({ codex: { extraArgs: ["--model=gpt"] } });
  });

  it("PUT rejects an unknown adapter id", async () => {
    const res = await performRequest(
      app,
      "PUT",
      "/api/cli-agents/settings",
      JSON.stringify({ adapterId: "evil", config: {} }),
      JSON_HEADERS,
    );
    expect(res.status).toBe(400);
  });

  it("autonomy approval round-trip (approve requires confirm)", async () => {
    // Initially unapproved.
    let res = await performRequest(app, "GET", "/api/cli-agents/claude-code/autonomy", undefined, JSON_HEADERS);
    expect(res.body).toEqual({ adapterId: "claude-code", approved: false });

    // Approve without confirm → rejected.
    res = await performRequest(
      app,
      "POST",
      "/api/cli-agents/claude-code/approve-autonomy",
      JSON.stringify({}),
      JSON_HEADERS,
    );
    expect(res.status).toBe(400);

    // Approve with confirm → granted.
    res = await performRequest(
      app,
      "POST",
      "/api/cli-agents/claude-code/approve-autonomy",
      JSON.stringify({ confirm: true }),
      JSON_HEADERS,
    );
    expect(res.status).toBe(200);
    expect(store.state.approvedCliAutonomyAdapters).toContain("claude-code");

    // Now reads as approved.
    res = await performRequest(app, "GET", "/api/cli-agents/claude-code/autonomy", undefined, JSON_HEADERS);
    expect(res.body.approved).toBe(true);

    // Revoke.
    res = await performRequest(
      app,
      "POST",
      "/api/cli-agents/claude-code/revoke-autonomy",
      JSON.stringify({}),
      JSON_HEADERS,
    );
    expect(res.status).toBe(200);
    expect(store.state.approvedCliAutonomyAdapters).not.toContain("claude-code");
  });
});
