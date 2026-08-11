// @vitest-environment node

import express from "express";
import multer from "multer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "@fusion/core";
import { request } from "../test-request.js";
import { registerChatRoutes } from "../routes/register-chat-routes.js";

function postJson(app: express.Express, body: unknown) {
  return request(app, "POST", "/api/chat/sessions", JSON.stringify(body), {
    "content-type": "application/json",
  });
}

/**
 * FNXC:AgentModelInheritance 2026-08-10-08:51:
 * Chat-session creation must persist the permanent role agent's inherited model and thinking
 * when callers leave both fields empty. This route-level fixture prevents a future route refactor
 * from bypassing the shared resolver after project settings have been loaded.
 */
describe("POST /api/chat/sessions permanent role model inheritance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses project inheritance while preserving client and complete agent overrides", async () => {
    const createSession = vi.fn(async (input: Record<string, unknown>) => ({ id: `session-${createSession.mock.calls.length}`, ...input }));
    const chatStore = { createSession };
    const mergerAgent = {
      id: "workflow-merger",
      roles: ["merger"],
      metadata: { builtInWorkflowRole: true, workflowRole: "merger" },
      runtimeConfig: { enabled: false },
    };
    const explicitAgent = {
      ...mergerAgent,
      id: "explicit-agent",
      runtimeConfig: { modelProvider: "agent-provider", modelId: "agent-model" },
    };

    vi.spyOn(AgentStore.prototype, "init").mockResolvedValue(undefined);
    vi.spyOn(AgentStore.prototype, "getAgent").mockImplementation(async (id) => (
      id === explicitAgent.id ? explicitAgent as never : mergerAgent as never
    ));

    const scopedStore = {
      getFusionDir: () => "/route-project/.fusion",
      getAsyncLayer: () => undefined,
      getSettings: async () => ({
        defaultProvider: "global-provider",
        defaultModelId: "global-model",
        defaultProviderOverride: "project-provider",
        defaultModelIdOverride: "project-model",
        defaultThinkingLevelOverride: "high",
      }),
    };
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerChatRoutes({
      router,
      store: scopedStore,
      options: { chatStore },
      getProjectContext: async () => ({ store: scopedStore, projectId: "project-1", engine: undefined }),
      rethrowAsApiError: (error: unknown) => { throw error; },
    } as never, {
      parseLastEventId: () => undefined,
      replayBufferedSSE: () => false,
      validateOptionalModelField: () => undefined,
      upload: multer(),
    });
    app.use("/api", router);

    const inherited = await postJson(app, { agentId: mergerAgent.id });
    expect(inherited.status).toBe(201);
    expect(inherited.body.session).toMatchObject({
      modelProvider: "project-provider",
      modelId: "project-model",
      thinkingLevel: "high",
    });

    const clientOverride = await postJson(app, {
      agentId: mergerAgent.id,
      modelProvider: "client-provider",
      modelId: "client-model",
    });
    expect(clientOverride.status).toBe(201);
    expect(clientOverride.body.session).toMatchObject({
      modelProvider: "client-provider",
      modelId: "client-model",
      thinkingLevel: "high",
    });

    const agentOverride = await postJson(app, { agentId: explicitAgent.id });
    expect(agentOverride.status).toBe(201);
    expect(agentOverride.body.session).toMatchObject({
      modelProvider: "agent-provider",
      modelId: "agent-model",
      thinkingLevel: "high",
    });
  });
});
