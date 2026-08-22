// @vitest-environment node

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession } from "@fusion/core";
import { request } from "../test-request.js";
import { ChatReplacementError, chatStreamManager } from "../chat.js";
import { registerChatRoutes } from "../routes/register-chat-routes.js";

function session(id = "session-1"): ChatSession {
  return {
    id,
    agentId: "__fn_agent__",
    title: "Edit test",
    status: "active",
    projectId: null,
    modelProvider: "anthropic",
    modelId: "claude-test",
    thinkingLevel: null,
    pinnedAt: null,
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}

function message(id: string, role: "user" | "assistant", content: string, createdAt: string): ChatMessage {
  return {
    id,
    sessionId: "session-1",
    role,
    content,
    thinkingOutput: null,
    metadata: null,
    createdAt,
  };
}

function buildApp(options: {
  messages?: ChatMessage[];
  prepare?: (messageId: string, messages: ChatMessage[]) => Promise<{ generationId: number; retained: ChatMessage[] }>;
  send?: (args: { sessionId: string; content: string; generationId?: number }) => Promise<void>;
} = {}) {
  const messages = options.messages ?? [
    message("prefix", "user", "Earlier", "2026-08-19T00:00:00.000Z"),
    message("target", "user", "Original", "2026-08-19T00:00:01.000Z"),
    message("later", "assistant", "Discarded reply", "2026-08-19T00:00:02.000Z"),
  ];
  const storedSession = session();
  const chatStore = {
    getSession: vi.fn(async (id: string) => id === storedSession.id ? storedSession : undefined),
    getMessage: vi.fn(async (id: string) => messages.find((candidate) => candidate.id === id)),
    getRootDir: () => "/tmp/fn-chat-message-edit-route",
    getFusionDir: () => "/tmp/fn-chat-message-edit-route/.fusion",
  };
  const chatManager = {
    prepareReplacement: vi.fn(async (sessionId: string, messageId: string) => {
      if (options.prepare) return options.prepare(messageId, messages);
      const targetIndex = messages.findIndex((candidate) => candidate.id === messageId);
      if (targetIndex < 0) throw new ChatReplacementError("target not found", 404);
      messages.splice(targetIndex);
      return { generationId: 41, retained: messages.slice() };
    }),
    beginGeneration: vi.fn(() => ({ generationId: 42, abortController: new AbortController() })),
    isGenerating: vi.fn(() => false),
    sendMessage: vi.fn(async (sessionId: string, content: string, _provider: string | undefined, _model: string | undefined, _attachments: unknown, opts: { generationId?: number }) => {
      if (options.send) {
        await options.send({ sessionId, content, generationId: opts?.generationId });
        return;
      }
      chatStreamManager.broadcast(sessionId, {
        type: "done",
        data: { messageId: "assistant-new" },
      }, { generationId: opts?.generationId });
    }),
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerChatRoutes({
    router,
    store: chatStore,
    options: { chatStore, chatManager },
    getProjectContext: async () => ({ store: chatStore, projectId: null, engine: undefined }),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never, {
    parseLastEventId: () => undefined,
    replayBufferedSSE: () => false,
    validateOptionalModelField: (value, fieldName) => {
      if (value === undefined || value === null || value === "") return undefined;
      if (typeof value !== "string") throw new Error(`${fieldName} must be a string`);
      return value.trim();
    },
    upload: {
      array: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
      single: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    },
  });
  app.use("/api", router);
  app.use((err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? "unknown" });
  });
  return { app, messages, chatManager, chatStore };
}

/*
FNXC:ChatMessageEdit 2026-08-19-03:34:
Symptom verification for the original two-request edit failure. The route must prepare the
replacement before SSE acceptance, send one trimmed replacement with the reserved generation,
and expose accepted provider errors through the same SSE terminal channel without restoring the
discarded transcript.
*/
describe("POST /api/chat/sessions/:id/messages replacement edit", () => {
  afterEach(() => {
    chatStreamManager.reset();
    vi.restoreAllMocks();
  });

  it("rewinds before acceptance and sends one trimmed replacement with the prepared generation", async () => {
    const prepareStarted = vi.fn();
    const releasePrepare = vi.fn<() => void>();
    const prepared = new Promise<{ generationId: number; retained: ChatMessage[] }>((resolve) => {
      releasePrepare.mockImplementation(() => resolve({ generationId: 17, retained: [] }));
    });
    const { app, chatManager, messages } = buildApp({
      prepare: async (messageId, rows) => {
        prepareStarted(messageId);
        rows.splice(rows.findIndex((row) => row.id === messageId));
        return prepared;
      },
    });

    const responsePromise = request(
      app,
      "POST",
      "/api/chat/sessions/session-1/messages",
      JSON.stringify({ content: "  corrected  ", replacementMessageId: "target" }),
      { "content-type": "application/json" },
    );
    await vi.waitFor(() => expect(prepareStarted).toHaveBeenCalledWith("target"));
    expect(chatManager.sendMessage).not.toHaveBeenCalled();
    expect(messages.map((row) => row.id)).toEqual(["prefix"]);

    releasePrepare();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(chatManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(chatManager.sendMessage.mock.calls[0]?.slice(0, 2)).toEqual(["session-1", "corrected"]);
    expect(chatManager.sendMessage.mock.calls[0]?.[5]).toEqual({ generationId: 17 });
    expect(response.body).toContain("event: done");
  });

  it.each([
    ["missing target", new ChatReplacementError("target missing", 404), 404],
    ["assistant target", new ChatReplacementError("Only user messages can be edited", 400), 400],
    ["active generation", new ChatReplacementError("generation is currently in progress", 400), 400],
    ["duplicate preparation", new ChatReplacementError("already being prepared", 409), 409],
  ] as const)("rejects %s before SSE acceptance", async (_name, error, status) => {
    const { app, chatManager } = buildApp({ prepare: async () => { throw error; } });
    const response = await request(
      app,
      "POST",
      "/api/chat/sessions/session-1/messages",
      JSON.stringify({ content: "corrected", replacementMessageId: "target" }),
      { "content-type": "application/json" },
    );
    expect(response.status).toBe(status);
    expect(chatManager.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps accepted provider failure on the SSE path after discarded history is committed", async () => {
    const { app, chatManager, messages } = buildApp({
      send: async ({ sessionId, generationId }) => {
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: { summary: "provider unavailable", code: "provider-error" },
        }, { generationId });
      },
    });
    const response = await request(
      app,
      "POST",
      "/api/chat/sessions/session-1/messages",
      JSON.stringify({ content: " corrected ", replacementMessageId: "target" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain("provider unavailable");
    expect(messages.map((row) => row.id)).toEqual(["prefix"]);
    expect(chatManager.sendMessage).toHaveBeenCalledTimes(1);
  });
});
