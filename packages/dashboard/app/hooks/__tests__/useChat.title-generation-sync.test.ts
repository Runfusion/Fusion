/*
FNXC:ChatWindows 2026-09-16-05:30:
FN-455: the server generates a conversation title in the background after the first message. When
that `chat:session:updated` arrives while the authoritative selection snapshot is still in flight,
the payload used to be dropped and the snapshot — read BEFORE the title write — restored the old
title, so the list row showed the generated name while the chat window header kept "Untitled
conversation". These cases pin the corrected invariant AND its bound: exactly `title` crosses the
deferred reapplication, and every other field stays owned by the authoritative snapshot.
*/

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@fusion/core";

vi.mock("../../api", () => ({
  fetchChatSessions: vi.fn(),
  fetchChatTags: vi.fn().mockResolvedValue({ tags: [] }),
  fetchChatSession: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  updateChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  streamChatResponse: vi.fn(() => ({ close: vi.fn() })),
  attachChatStream: vi.fn(),
  cancelChatResponse: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
  getPersistedChatOpenSession: vi.fn(),
  setPersistedChatOpenSession: vi.fn(),
  clearPersistedChatOpenSession: vi.fn(),
}));

const { sseHandlers } = vi.hoisted(() => ({
  sseHandlers: { current: {} as Record<string, (event: MessageEvent) => void> },
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, options: { events?: Record<string, (e: MessageEvent) => void> }) => {
    if (options?.events) sseHandlers.current = options.events;
    return () => {};
  }),
}));

import { useChat } from "../useChat";
import * as apiModule from "../../api";

const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockFetchChatSession = vi.mocked(apiModule.fetchChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockAttachChatStream = vi.mocked(apiModule.attachChatStream);
const mockStreamChatResponse = vi.mocked(apiModule.streamChatResponse);

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-001",
    agentId: "agent-001",
    status: "active",
    title: null,
    projectId: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    pinnedAt: null,
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
    isGenerating: false,
    ...overrides,
  } as ChatSession;
}

function emitSessionUpdated(session: unknown): void {
  act(() => {
    sseHandlers.current["chat:session:updated"]?.({ data: JSON.stringify(session) } as MessageEvent);
  });
}

/** A `fetchChatSession` promise the test resolves/rejects by hand. */
function deferredSessionRead(): {
  resolve: (session: unknown) => void;
  reject: (error: unknown) => void;
} {
  let resolveFn!: (value: unknown) => void;
  let rejectFn!: (reason: unknown) => void;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  mockFetchChatSession.mockReturnValue(promise as never);
  return {
    resolve: (session) => {
      resolveFn({ session });
    },
    reject: rejectFn,
  };
}

describe("useChat — generated title reaches the open conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sseHandlers.current = {};
    mockFetchChatMessages.mockResolvedValue({ messages: [] } as never);
    // A stream that never completes keeps `isStreaming` true for the duration of a case.
    mockStreamChatResponse.mockReturnValue({ close: vi.fn() } as never);
  });

  async function renderWithSelectionInFlight(untitled = makeSession()) {
    mockFetchChatSessions.mockResolvedValue({ sessions: [untitled] } as never);
    const rendered = renderHook(() => useChat("proj-1"));
    await waitFor(() => expect(rendered.result.current.sessions).toHaveLength(1));

    const pending = deferredSessionRead();
    act(() => {
      rendered.result.current.selectSession(untitled.id);
    });
    await waitFor(() => expect(mockFetchChatSession).toHaveBeenCalled());
    return { ...rendered, pending };
  }

  // (C1) The reported symptom: list row renamed, window header stuck on the old title.
  it("applies a generated title delivered while the authoritative snapshot is in flight", async () => {
    const { result, pending } = await renderWithSelectionInFlight();

    emitSessionUpdated(makeSession({ title: "Titre généré" }));

    // The authoritative read resolves with the PRE-title snapshot.
    await act(async () => {
      pending.resolve(makeSession({ title: null }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.activeSession?.title).toBe("Titre généré");
      expect(result.current.sessions[0]?.title).toBe("Titre généré");
    });
  });

  // (C2) Non-regression: with no authoritative read in flight, the payload applies directly.
  it("applies a generated title immediately when no authoritative read is in flight", async () => {
    const untitled = makeSession();
    mockFetchChatSessions.mockResolvedValue({ sessions: [untitled] } as never);
    mockFetchChatSession.mockResolvedValue({ session: untitled } as never);

    const { result } = renderHook(() => useChat("proj-1"));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(async () => {
      result.current.selectSession("session-001");
    });
    await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

    emitSessionUpdated(makeSession({ title: "Titre direct" }));

    await waitFor(() => {
      expect(result.current.activeSession?.title).toBe("Titre direct");
      expect(result.current.sessions[0]?.title).toBe("Titre direct");
    });
  });

  // (C6) A failing authoritative read leaves the deferred title as the only fresh data.
  it("still applies the deferred title when the authoritative read rejects", async () => {
    const { result, pending } = await renderWithSelectionInFlight();

    emitSessionUpdated(makeSession({ title: "Titre malgré panne" }));

    await act(async () => {
      pending.reject(new Error("transport down"));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.activeSession?.title).toBe("Titre malgré panne"));
  });

  // (C7) Negative control: a deferred title from a retired selection never reaches a new thread.
  it("never applies a deferred title to a thread selected afterwards", async () => {
    const first = makeSession({ id: "session-A" });
    const second = makeSession({ id: "session-B", title: "Fil B" });
    mockFetchChatSessions.mockResolvedValue({ sessions: [first, second] } as never);

    const { result } = renderHook(() => useChat("proj-1"));
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    const pendingA = deferredSessionRead();
    act(() => {
      result.current.selectSession("session-A");
    });
    await waitFor(() => expect(mockFetchChatSession).toHaveBeenCalled());

    emitSessionUpdated(makeSession({ id: "session-A", title: "Titre du fil A" }));

    // Operator switches to B before A's snapshot lands.
    const pendingB = deferredSessionRead();
    act(() => {
      result.current.selectSession("session-B");
    });
    await act(async () => {
      pendingA.resolve(makeSession({ id: "session-A", title: null }));
      pendingB.resolve(second);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.activeSession?.id).toBe("session-B"));
    expect(result.current.activeSession?.title).toBe("Fil B");
  });

  /*
   * (k) FN-505: naming is now a TWO-STAGE write — a provisional title lands before the assistant
   * replies, then the refined one replaces it. Both updates arrive mid-stream, which is exactly the
   * moment the operator reported the header going stale, so both must reach the header AND the list
   * row without disturbing the live thread.
   */
  it("applies both the provisional and the refined title while streaming", async () => {
    const untitled = makeSession();
    mockFetchChatSessions.mockResolvedValue({ sessions: [untitled] } as never);
    mockFetchChatSession.mockResolvedValue({ session: untitled } as never);

    const { result } = renderHook(() => useChat("proj-1"));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(async () => {
      result.current.selectSession("session-001");
    });
    await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

    act(() => {
      result.current.sendMessage("Corrige le titre de la conversation");
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(true));
    const messageCount = result.current.messages.length;

    emitSessionUpdated(makeSession({ title: "Corrige le titre de la conversation" }));
    await waitFor(() => {
      expect(result.current.activeSession?.title).toBe("Corrige le titre de la conversation");
      expect(result.current.sessions[0]?.title).toBe("Corrige le titre de la conversation");
    });

    emitSessionUpdated(makeSession({ title: "Titre de conversation" }));
    await waitFor(() => {
      expect(result.current.activeSession?.title).toBe("Titre de conversation");
      expect(result.current.sessions[0]?.title).toBe("Titre de conversation");
    });

    // The live thread is untouched: still the same session, still streaming, same messages.
    expect(result.current.activeSession?.id).toBe("session-001");
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages).toHaveLength(messageCount);
  });

  /*
   * (l) The two-stage write also has to survive the FN-455 deferred path: a provisional title can
   * land while the authoritative selection snapshot is still in flight, with the refined one right
   * behind it. The refined title must win after reconciliation, and still nothing but `title` crosses.
   */
  it("ends on the refined title when the provisional one crosses the deferred path", async () => {
    const { result, pending } = await renderWithSelectionInFlight();

    emitSessionUpdated(makeSession({ title: "Corrige le titre de la conversation", pinnedAt: "2026-09-16T01:00:00.000Z" }));
    emitSessionUpdated(makeSession({ title: "Titre de conversation", pinnedAt: "2026-09-16T01:00:00.000Z" }));

    await act(async () => {
      pending.resolve(makeSession({ title: null, pinnedAt: null }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.activeSession?.title).toBe("Titre de conversation");
      expect(result.current.sessions[0]?.title).toBe("Titre de conversation");
    });
    // Only `title` crosses the deferred reapplication.
    expect(result.current.activeSession?.pinnedAt).toBeNull();
  });

  /*
   * (C8) Bounding negative control — the whole reason the deferral is allowlisted to `title`.
   * The deferred payload also carries a STALE cursor/generation state; none of it may cross.
   */
  it("lets only the title cross: cursor and generation state stay authoritative", async () => {
    const { result, pending } = await renderWithSelectionInFlight();

    emitSessionUpdated({
      ...makeSession({ title: "Titre généré" }),
      isGenerating: true,
      inFlightGeneration: { generationId: 7, lastEventId: 3, text: "périmé" },
      status: "stale-status",
      updatedAt: "2026-09-15T00:00:00.000Z",
      lastMessagePreview: "aperçu périmé",
      lastMessageAt: "2026-09-15T00:00:00.000Z",
    });

    const authoritative = {
      ...makeSession({ title: null }),
      isGenerating: false,
      inFlightGeneration: null,
      status: "active",
      updatedAt: "2026-09-16T12:00:00.000Z",
      lastMessagePreview: "aperçu autoritaire",
      lastMessageAt: "2026-09-16T12:00:00.000Z",
    };

    await act(async () => {
      pending.resolve(authoritative);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.activeSession?.title).toBe("Titre généré"));

    const active = result.current.activeSession!;
    expect(active.isGenerating).toBe(false);
    expect(active.inFlightGeneration).toBeNull();
    expect(active.status).toBe("active");
    expect(active.updatedAt).toBe("2026-09-16T12:00:00.000Z");
    expect(active.lastMessagePreview).toBe("aperçu autoritaire");
    expect(active.lastMessageAt).toBe("2026-09-16T12:00:00.000Z");
    // No stream ownership is claimed from the deferred path.
    expect(mockAttachChatStream).not.toHaveBeenCalled();
  });

  /*
   * (C9) Bounding negative control, rewritten by FN-524. A payload with NO `title` field asserts
   * nothing about the name, so the authoritative snapshot keeps its own title — and still nothing
   * but `title` may ever cross the deferred reapplication.
   */
  it("leaves the authoritative snapshot untouched when the payload carries no title field", async () => {
    const { result, pending } = await renderWithSelectionInFlight();

    const { title: _omitted, ...withoutTitle } = makeSession({ pinnedAt: "2026-09-16T01:00:00.000Z" });
    emitSessionUpdated(withoutTitle);

    await act(async () => {
      pending.resolve(makeSession({ title: "Titre autoritaire", pinnedAt: null }));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.activeSession?.title).toBe("Titre autoritaire"));
    expect(result.current.activeSession?.pinnedAt).toBeNull();
  });

  /*
   * (b) FN-524: the authoritative read resolves for a DIFFERENT session id than the selection.
   * That early-exit branch used to discard the deferred title outright, so the list row carried the
   * new name while the open conversation header kept the old one — the reported divergence.
   */
  it("applies the deferred title when the authoritative read resolves for another session id", async () => {
    const { result, pending } = await renderWithSelectionInFlight();

    emitSessionUpdated(makeSession({ title: "Titre reporté" }));

    await act(async () => {
      pending.resolve(makeSession({ id: "session-autre", title: "Titre étranger" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.sessions[0]?.title).toBe("Titre reporté");
      expect(result.current.activeSession?.title).toBe("Titre reporté");
    });
    expect(result.current.activeSession?.id).toBe("session-001");
  });

  /*
   * (c) FN-524: the authoritative read resolves without a boolean `isGenerating` (legacy/malformed
   * response). That early-exit branch also dropped the deferred title on the floor.
   */
  it("applies the deferred title when the authoritative read omits the isGenerating boolean", async () => {
    const { result, pending } = await renderWithSelectionInFlight();

    emitSessionUpdated(makeSession({ title: "Titre reporté" }));

    await act(async () => {
      const { isGenerating: _omitted, ...legacy } = makeSession({ title: null });
      pending.resolve(legacy);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.sessions[0]?.title).toBe("Titre reporté");
      expect(result.current.activeSession?.title).toBe("Titre reporté");
    });
  });

  /*
   * (d) FN-524: a CLEARED title is a real rename. The deferral used to be armed only for a non-empty
   * trimmed string, so an erased name left the list row empty while the header resurrected the old
   * one. Both sides must converge on the cleared value.
   */
  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["null", null],
  ])("applies a title cleared to %s while the authoritative snapshot is in flight", async (_label, clearedTitle) => {
    const named = makeSession({ title: "Ancien titre" });
    const { result, pending } = await renderWithSelectionInFlight(named);

    emitSessionUpdated(makeSession({ title: clearedTitle as string | null }));

    await act(async () => {
      pending.resolve(makeSession({ title: "Ancien titre" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.sessions[0]?.title ?? "").toBe(clearedTitle ?? "");
      expect(result.current.activeSession?.title ?? "").toBe(clearedTitle ?? "");
    });
    expect(result.current.activeSession?.title?.trim() || null).toBeNull();
  });
});
