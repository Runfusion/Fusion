// @vitest-environment node

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-request.js";
import { registerChatRoutes } from "../routes/register-chat-routes.js";

const { mockResolveProjectChatContext, mockGetOrCreateScopedChatManager } = vi.hoisted(() => ({
  mockResolveProjectChatContext: vi.fn(),
  mockGetOrCreateScopedChatManager: vi.fn(),
}));

vi.mock("../chat-project-services.js", () => ({
  resolveProjectChatContext: mockResolveProjectChatContext,
  getOrCreateScopedChatManager: mockGetOrCreateScopedChatManager,
}));

function makeApp(manager: { cancelGeneration: ReturnType<typeof vi.fn> }) {
  const router = express.Router();
  const app = express();
  app.use(express.json());
  app.use("/api", router);

  registerChatRoutes({
    router,
    store: {} as any,
    options: { chatManager: manager } as any,
    runtimeLogger: {} as any,
    planningLogger: {} as any,
    chatLogger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() } as any,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: vi.fn(),
    getProjectContext: vi.fn().mockResolvedValue({ store: {}, projectId: "project-a", engine: undefined }),
    getProjectPluginLoader: vi.fn(),
    prioritizeProjectsForCurrentDirectory: (projects: unknown[]) => projects,
    emitRemoteRouteDiagnostic: vi.fn(),
    emitAuthSyncAuditLog: vi.fn(),
    parseScopeParam: vi.fn(),
    resolveAutomationStore: vi.fn(),
    resolveRoutineStore: vi.fn(),
    resolveRoutineRunner: vi.fn(),
    registerDispose: vi.fn(),
    dispose: vi.fn(),
    rethrowAsApiError: (error: unknown): never => { throw error; },
  } as any, {
    parseLastEventId: () => undefined,
    replayBufferedSSE: () => false,
    validateOptionalModelField: () => undefined,
    upload: {
      single: () => (_req: unknown, _res: unknown, next: () => void) => next(),
      array: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    } as any,
  });

  return app;
}

describe("POST /api/chat/sessions/:id/cancel", () => {
  beforeEach(() => {
    mockResolveProjectChatContext.mockResolvedValue({ store: {}, chatStore: {} });
    mockGetOrCreateScopedChatManager.mockImplementation(() => currentManager);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  let currentManager: { cancelGeneration: ReturnType<typeof vi.fn> };

  it("awaits the scoped manager's durable result before responding", async () => {
    let resolveCancellation!: (value: unknown) => void;
    const cancellation = new Promise((resolve) => { resolveCancellation = resolve; });
    currentManager = { cancelGeneration: vi.fn(() => cancellation) };
    const app = makeApp(currentManager);

    let responseSettled = false;
    const responsePromise = request(app, "POST", "/api/chat/sessions/chat-1/cancel?projectId=project-a")
      .then((response) => {
        responseSettled = true;
        return response;
      });

    await new Promise((resolve) => setImmediate(resolve));
    expect(responseSettled).toBe(false);
    expect(mockResolveProjectChatContext).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-a" }));

    resolveCancellation({
      success: true,
      interrupted: true,
      message: { id: "assistant-1", content: "partial", metadata: { interrupted: true } },
    });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      interrupted: true,
      message: expect.objectContaining({ id: "assistant-1" }),
    }));
    expect(currentManager.cancelGeneration).toHaveBeenCalledWith("chat-1");
  });

  it("passes through the scoped manager's successful idle no-op without inventing a message", async () => {
    currentManager = {
      cancelGeneration: vi.fn().mockResolvedValue({ success: true, interrupted: false }),
    };
    const response = await request(makeApp(currentManager), "POST", "/api/chat/sessions/chat-idle/cancel?projectId=project-a");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, interrupted: false });
    expect(response.body.message).toBeUndefined();
    expect(currentManager.cancelGeneration).toHaveBeenCalledWith("chat-idle");
  });
});
