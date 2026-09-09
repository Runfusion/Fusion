import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskPlannerChatTab } from "../TaskPlannerChatTab";

const mocks = vi.hoisted(() => ({
  fetchTaskPlannerChatSession: vi.fn(),
  fetchChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  attachChatStream: vi.fn(() => ({ close: vi.fn(), isConnected: () => true })),
  t: (_key: string, fallback: string) => fallback,
}));

vi.mock("../../hooks/useModelsCache", () => ({ useModelsCache: () => ({ models: [], favoriteProviders: [], favoriteModels: [] }) }));
vi.mock("../../hooks/useFavorites", () => ({
  useFavorites: () => ({ availableModels: [], favoriteProviders: [], favoriteModels: [], providerInstances: {}, toggleFavoriteProvider: vi.fn(), toggleFavoriteModel: vi.fn() }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchTaskPlannerChatSession: mocks.fetchTaskPlannerChatSession,
  fetchChatSession: mocks.fetchChatSession,
  fetchChatMessages: mocks.fetchChatMessages,
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchGlobalSettings: vi.fn().mockResolvedValue({ chatSnippets: [] }),
  fetchTaskDetail: vi.fn(),
  updateChatSession: vi.fn(),
  attachChatStream: mocks.attachChatStream,
  streamChatResponse: vi.fn(() => ({ close: vi.fn(), isConnected: () => true })),
  cancelChatResponse: vi.fn().mockResolvedValue({ success: true }),
  ensureTaskPlannerChatSession: vi.fn(),
  addSteeringComment: vi.fn(),
}));

const session = {
  id: "planner-session",
  agentId: "task-planner:FN-304",
  title: "Planner",
  status: "active",
  projectId: null,
  modelProvider: "anthropic",
  modelId: "model",
  thinkingLevel: null,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  pinnedAt: null,
  cliSessionFile: null,
  cliExecutorAdapterId: null,
  inFlightGeneration: null,
};

const messages = Array.from({ length: 1_000 }, (_, index) => ({
  id: `planner-${String(index).padStart(4, "0")}`,
  sessionId: session.id,
  role: index % 2 ? "assistant" as const : "user" as const,
  content: `Planner rich message ${index}\n\n- markdown`,
  thinkingOutput: index % 3 === 0 ? `Reasoning ${index}` : null,
  metadata: index % 5 === 0 ? { toolCalls: [{ name: "read", status: "completed", result: "ok" }] } : null,
  createdAt: "2026-09-06T12:00:00.000Z",
}));

let intersectionCallback: IntersectionObserverCallback | undefined;
class FakeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) { intersectionCallback = callback; }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
  root = null;
  rootMargin = "0px";
  thresholds = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  intersectionCallback = undefined;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  mocks.fetchTaskPlannerChatSession.mockResolvedValue({ session });
  mocks.fetchChatSession.mockResolvedValue({ session });
  mocks.fetchChatMessages.mockImplementation(async (_sessionId: string, options?: { beforeId?: string }) => {
    const end = options?.beforeId ? messages.findIndex((message) => message.id === options.beforeId) : messages.length;
    return { messages: messages.slice(Math.max(0, end - 50), end).reverse() };
  });
});

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_024 });
  vi.unstubAllGlobals();
});

function renderPlanner(expanded = false) {
  return render(<TaskPlannerChatTab
    task={{ id: "FN-304", description: "Task", column: "todo", dependencies: [], steps: [], currentStep: 0, createdAt: session.createdAt, updatedAt: session.updatedAt } as never}
    active
    expanded={expanded}
    taskChatModel={{ provider: "anthropic", modelId: "model" }}
    addToast={vi.fn()}
  />);
}

/*
FNXC:ChatTranscriptVirtualization 2026-09-06-14:31:
The production Planner Chat host must recover large tied-timestamp histories through its sentinel and serialized tuple pages before DOM bounds are asserted. Explicit normal/expanded and desktop/mobile geometries exercise the shipped scroll owner; walking the virtual viewport proves every recovered ID remains reachable, and live text/thinking/tool-call growth proves pinned and detached readers keep their scroll contracts without a one-page fixture bypass.
*/
describe("TaskPlannerChatTab transcript virtualization", () => {
  it.each([
    [false, 1_280, 720],
    [true, 390, 360],
  ] as const)("paginates and bounds a 1,000-row rich transcript (expanded=%s, width=%i)", async (expanded, width, height) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    renderPlanner(expanded);
    await waitFor(() => expect(mocks.fetchChatMessages).toHaveBeenCalledTimes(1));
    const transcript = document.querySelector<HTMLElement>(".task-planner-chat-transcript")!;
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: height },
      scrollHeight: { configurable: true, value: 112_000 },
      scrollTop: { configurable: true, writable: true, value: 111_280 },
    });
    act(() => fireEvent.scroll(transcript));

    for (let page = 1; page < 20; page += 1) {
      expect(intersectionCallback).toBeTypeOf("function");
      act(() => intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
      await waitFor(() => expect(mocks.fetchChatMessages).toHaveBeenCalledTimes(page + 1));
    }

    const cursors = mocks.fetchChatMessages.mock.calls.slice(1).map((call) => call[1]?.beforeId);
    expect(cursors).toHaveLength(19);
    expect(cursors[0]).toBe("planner-0950");
    expect(cursors.at(-1)).toBe("planner-0050");
    expect(new Set(cursors).size).toBe(19);
    expect(document.querySelectorAll(".chat-message").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".chat-message").length).toBeLessThanOrEqual(60);
    expect(document.querySelectorAll(".task-planner-chat-transcript-spacer[aria-hidden='true']").length).toBeGreaterThan(0);
  });

  it("borne le streaming riche après 1 000 messages paginés, épinglé puis détaché", async () => {
    let streamHandlers: {
      onText(delta: string): void;
      onThinking(delta: string): void;
      onToolStart(data: { toolName: string; args?: Record<string, unknown> }): void;
    } | undefined;
    const generatingSession = {
      ...session,
      isGenerating: true,
      inFlightGeneration: {
        status: "generating" as const,
        streamingText: "",
        streamingThinking: "",
        toolCalls: [],
        replayFromEventId: 1,
        updatedAt: session.updatedAt,
      },
    };
    mocks.fetchTaskPlannerChatSession.mockResolvedValue({ session: generatingSession });
    mocks.fetchChatSession.mockResolvedValue({ session: generatingSession });
    mocks.attachChatStream.mockImplementation((_sessionId, handlers) => {
      streamHandlers = handlers;
      return { close: vi.fn(), isConnected: () => true };
    });
    renderPlanner();
    await waitFor(() => expect(mocks.fetchChatMessages).toHaveBeenCalledTimes(1));
    for (let page = 1; page < 20; page += 1) {
      expect(intersectionCallback).toBeTypeOf("function");
      act(() => intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
      await waitFor(() => expect(mocks.fetchChatMessages).toHaveBeenCalledTimes(page + 1));
    }
    await waitFor(() => expect(streamHandlers).toBeDefined());

    const transcript = document.querySelector<HTMLElement>(".task-planner-chat-transcript")!;
    let scrollTop = 111_280;
    let scrollHeight = 112_000;
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 720 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
    });
    act(() => fireEvent.scroll(transcript));

    const expectBounded = () => expect(document.querySelectorAll(".chat-message").length).toBeLessThanOrEqual(60);
    scrollHeight = 112_200;
    act(() => streamHandlers?.onText("Plan massif en cours"));
    await waitFor(() => expect(scrollTop).toBe(scrollHeight));
    expect(document.body.textContent).toContain("Plan massif en cours");
    expectBounded();

    scrollHeight = 112_300;
    act(() => streamHandlers?.onThinking("Raisonnement Planner massif"));
    await waitFor(() => expect(scrollTop).toBe(scrollHeight));
    expect(document.body.textContent).toContain("Raisonnement Planner massif");
    expectBounded();

    scrollHeight = 112_400;
    act(() => streamHandlers?.onToolStart({ toolName: "planner_massive_stream_tool", args: { path: "PROMPT.md" } }));
    await waitFor(() => expect(scrollTop).toBe(scrollHeight));
    expect(document.body.textContent).toContain("planner_massive_stream_tool");
    expectBounded();

    scrollTop = 24_000;
    act(() => fireEvent.scroll(transcript));
    for (const [height, update] of [
      [112_600, () => streamHandlers?.onText(" suite détachée")],
      [112_700, () => streamHandlers?.onThinking(" suite détachée")],
      [112_800, () => streamHandlers?.onToolStart({ toolName: "planner_detached_stream_tool", args: { pattern: "virtual" } })],
    ] as const) {
      scrollHeight = height;
      act(update);
      await waitFor(() => expect(document.querySelectorAll(".chat-message").length).toBeGreaterThan(0));
      expect(scrollTop).toBe(24_000);
      expectBounded();
    }
  });

  it("paginates 125 tied rows once with strict cursors and bounded DOM", async () => {
    const tied = messages.slice(0, 125);
    mocks.fetchChatMessages.mockImplementation(async (_sessionId: string, options?: { beforeId?: string }) => {
      const end = options?.beforeId ? tied.findIndex((message) => message.id === options.beforeId) : tied.length;
      return { messages: tied.slice(Math.max(0, end - 50), end).reverse() };
    });
    renderPlanner();
    await waitFor(() => expect(mocks.fetchChatMessages).toHaveBeenCalledTimes(1));
    for (let page = 1; page < 3; page += 1) {
      expect(intersectionCallback).toBeTypeOf("function");
      act(() => intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
      await waitFor(() => expect(mocks.fetchChatMessages).toHaveBeenCalledTimes(page + 1));
      await waitFor(() => expect(document.querySelector(".task-planner-chat-history-sentinel")?.textContent ?? "").toBe(""));
    }
    const cursors = mocks.fetchChatMessages.mock.calls.slice(1).map((call) => call[1]?.beforeId);
    expect(cursors).toEqual(["planner-0075", "planner-0025"]);

    const transcript = document.querySelector<HTMLElement>(".task-planner-chat-transcript")!;
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 14_000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    const visited = new Set<string>();
    for (let scrollTop = 0; scrollTop <= 13_600; scrollTop += 280) {
      transcript.scrollTop = scrollTop;
      act(() => fireEvent.scroll(transcript));
      for (const element of document.querySelectorAll<HTMLElement>(".chat-message[data-message-id]")) {
        if (element.dataset.messageId) visited.add(element.dataset.messageId);
      }
    }
    expect(visited).toEqual(new Set(tied.map((message) => message.id)));
    expect(document.querySelectorAll(".chat-message").length).toBeLessThanOrEqual(60);
  });
});
