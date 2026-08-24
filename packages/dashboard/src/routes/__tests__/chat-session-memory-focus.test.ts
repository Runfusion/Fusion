// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request as performRequest } from "../../test-request.js";
import { registerChatRoutes, type ChatRouteDeps } from "../register-chat-routes.js";
import type { ApiRoutesContext } from "../types.js";
import type { ChatSession, ChatStore } from "@fusion/core";

/**
 * RUFU-068 chat-session memory-focus route contract.
 *
 * The PATCH /api/chat/sessions/:id route must accept, validate, and persist the
 * `memoryFocus` body field via the committed ChatStore.setSessionMemoryFocus
 * persister, while leaving every existing update consumer (status/title/model/
 * agent/pinned/tagIds/thinkingLevel) untouched.
 *
 * FNXC:ChatMemoryFocusRouteTest 2026-08-13:
 * An omitted `memoryFocus` key leaves the stored value untouched ("omitted keys
 * stay untouched" contract shared by status/title/thinkingLevel/model). An empty
 * string / null is an intentional clear back to whole-project scope. A non-string
 * value is rejected with 400 (mirrors the `pinned must be a boolean` validation
 * pattern). The response session reflects the updated focus.
 */

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "sess-1",
    agentId: "agent-1",
    tags: [],
    title: "Direct",
    status: "active",
    projectId: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    memoryFocus: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function createChatStore() {
  const updateSession = vi.fn<ChatStore["updateSession"]>();
  const setSessionMemoryFocus = vi.fn<ChatStore["setSessionMemoryFocus"]>();
  const setSessionPinned = vi.fn<ChatStore["setSessionPinned"]>();
  const replaceSessionTags = vi.fn<ChatStore["replaceSessionTags"]>();
  return {
    updateSession,
    setSessionMemoryFocus,
    setSessionPinned,
    replaceSessionTags,
  } as unknown as ChatStore;
}

function createApp(opts: { chatStore?: ChatStore } = {}) {
  const router = express.Router();
  const rethrowAsApiError = vi.fn((error: unknown) => {
    throw error;
  });
  // FNXC:ChatMemoryFocusRouteTest — resolveProjectChatContext ->
  // getOrCreateScopedChatStore calls cacheKeyForStore(store) FIRST, which needs
  // store.getFusionDir(). Provide a minimal stub so the host-default store path
  // resolves before the fallback chatStore short-circuits.
  const store = {
    getFusionDir: vi.fn(() => "/tmp/chat-project/.fusion"),
  } as never;

  const deps: ChatRouteDeps = {
    parseLastEventId: vi.fn(() => undefined),
    replayBufferedSSE: vi.fn(() => false),
    validateOptionalModelField: vi.fn((value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)),
    upload: { single: vi.fn(), array: vi.fn() } as never,
  };

  registerChatRoutes(
    {
      router,
      store,
      options: { chatStore: opts.chatStore },
      chatLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
      getProjectContext: vi.fn(() => Promise.resolve({ projectId: undefined, store, engine: undefined }) as never),
      rethrowAsApiError,
    } as ApiRoutesContext,
    deps,
  );

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? String(err) });
  });
  return { app, chatStore: opts.chatStore as ChatStore };
}

function pickChatStore(store: any): { updateSession: any; setSessionMemoryFocus: any; setSessionPinned: any; replaceSessionTags: any } {
  return store;
}

describe("PATCH /api/chat/sessions/:id memory focus (RUFU-068)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists a non-empty focus via setSessionMemoryFocus and returns the updated session", async () => {
    const chatStore = createChatStore();
    const { app } = createApp({ chatStore });
    const { updateSession, setSessionMemoryFocus } = pickChatStore(chatStore);
    updateSession.mockResolvedValue(session());
    setSessionMemoryFocus.mockResolvedValue(session({ memoryFocus: "stash lcm" }));

    const res = await performRequest(
      app,
      "PATCH",
      "/api/chat/sessions/sess-1",
      JSON.stringify({ memoryFocus: "stash lcm" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(setSessionMemoryFocus).toHaveBeenCalledWith("sess-1", "stash lcm");
    expect(res.body.session.memoryFocus).toBe("stash lcm");
  });

  it("an explicit empty string clears the focus to null (whole-project scope)", async () => {
    const chatStore = createChatStore();
    const { app } = createApp({ chatStore });
    const { updateSession, setSessionMemoryFocus } = pickChatStore(chatStore);
    updateSession.mockResolvedValue(session());
    // setSessionMemoryFocus normalizes empty->null itself; the route passes it through.
    setSessionMemoryFocus.mockResolvedValue(session({ memoryFocus: null }));

    const res = await performRequest(
      app,
      "PATCH",
      "/api/chat/sessions/sess-1",
      JSON.stringify({ memoryFocus: "" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(setSessionMemoryFocus).toHaveBeenCalledWith("sess-1", "");
    expect(res.body.session.memoryFocus).toBeNull();
  });

  it("explicit null clears the focus to whole-project scope", async () => {
    const chatStore = createChatStore();
    const { app } = createApp({ chatStore });
    const { updateSession, setSessionMemoryFocus } = pickChatStore(chatStore);
    updateSession.mockResolvedValue(session({ memoryFocus: "old" }));
    setSessionMemoryFocus.mockResolvedValue(session({ memoryFocus: null }));

    const res = await performRequest(
      app,
      "PATCH",
      "/api/chat/sessions/sess-1",
      JSON.stringify({ memoryFocus: null }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(setSessionMemoryFocus).toHaveBeenCalledWith("sess-1", null);
    expect(res.body.session.memoryFocus).toBeNull();
  });

  it("omitting the field leaves the stored value untouched (does NOT call setSessionMemoryFocus)", async () => {
    const chatStore = createChatStore();
    const { app } = createApp({ chatStore });
    const { updateSession, setSessionMemoryFocus } = pickChatStore(chatStore);
    updateSession.mockResolvedValue(session({ title: "Renamed", memoryFocus: "existing topic" }));

    const res = await performRequest(
      app,
      "PATCH",
      "/api/chat/sessions/sess-1",
      JSON.stringify({ title: "Renamed" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(setSessionMemoryFocus).not.toHaveBeenCalled();
    // updateSession still runs for the other fields
    expect(updateSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({ title: "Renamed" }));
    expect(res.body.session.memoryFocus).toBe("existing topic");
  });

  it("rejects a non-string focus with 400", async () => {
    const chatStore = createChatStore();
    const { app } = createApp({ chatStore });

    const res = await performRequest(
      app,
      "PATCH",
      "/api/chat/sessions/sess-1",
      JSON.stringify({ memoryFocus: { topic: "not-a-string" } }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/memoryFocus must be a string/i);
  });

  it("co-exists with existing update consumers (status, pinned, thinkingLevel)", async () => {
    const chatStore = createChatStore();
    const { app } = createApp({ chatStore });
    const { updateSession, setSessionMemoryFocus, setSessionPinned } = pickChatStore(chatStore);
    updateSession.mockResolvedValue(session());
    setSessionMemoryFocus.mockResolvedValue(session({ memoryFocus: "topic-a" }));
    setSessionPinned.mockResolvedValue(session({ memoryFocus: "topic-a" }));

    const res = await performRequest(
      app,
      "PATCH",
      "/api/chat/sessions/sess-1",
      JSON.stringify({ status: "archived", pinned: true, memoryFocus: "topic-a" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(updateSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({ status: "archived" }));
    expect(setSessionPinned).toHaveBeenCalledWith("sess-1", true);
    expect(setSessionMemoryFocus).toHaveBeenCalledWith("sess-1", "topic-a");
  });

  it("returns 404 when the session does not exist", async () => {
    const chatStore = createChatStore();
    const { app } = createApp({ chatStore });
    const { updateSession, setSessionMemoryFocus } = pickChatStore(chatStore);
    updateSession.mockResolvedValue(undefined);
    setSessionMemoryFocus.mockResolvedValue(undefined);

    const res = await performRequest(
      app,
      "PATCH",
      "/api/chat/sessions/missing",
      JSON.stringify({ memoryFocus: "stash lcm" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(404);
  });
});