import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@fusion/core";
import { ChatView } from "../ChatView";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";
import * as api from "../../api";

const navigation = vi.hoisted(() => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => navigation,
}));

vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchChatSessions: vi.fn(),
  fetchChatSession: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  updateChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  backfillChatSessionToStash: vi.fn(),
  attachChatStream: vi.fn(),
  streamChatResponse: vi.fn(),
  cancelChatResponse: vi.fn(),
  fetchChatTags: vi.fn().mockResolvedValue({ tags: [] }),
  createChatTag: vi.fn(),
  renameChatTag: vi.fn(),
  deleteChatTag: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

const fetchChatSessions = vi.mocked(api.fetchChatSessions);
const fetchChatSession = vi.mocked(api.fetchChatSession);
const fetchChatMessages = vi.mocked(api.fetchChatMessages);

let floatingWidth = 1200;

function session(id = "requested-thread", title = "Requested thread"): ChatSession {
  return {
    id,
    agentId: "agent-1",
    tags: [],
    title,
    status: "active",
    projectId: "project-a",
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    memoryFocus: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    pinnedAt: null,
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
  };
}

function entry(id = "requested-thread", focusNonce = 1) {
  return { projectId: "project-a", session: session(id), focusNonce, cascadeSlot: 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderWindows(entries = [entry()]) {
  return render(
    <PoppedOutChatWindows
      entries={entries}
      projectId="project-a"
      addToast={vi.fn()}
      onClose={vi.fn()}
      onOpenSessionInNewWindow={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchChatSessions.mockReset();
  fetchChatSession.mockReset();
  fetchChatMessages.mockReset();
  localStorage.clear();
  floatingWidth = 1200;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    width: floatingWidth,
    height: 680,
    top: 0,
    right: floatingWidth,
    bottom: 680,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }));
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() { this.callback([], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  });
  fetchChatSession.mockImplementation(async (id) => ({ session: session(id) }));
  fetchChatMessages.mockResolvedValue({ messages: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PoppedOutChatWindows requested-thread arrival", () => {
  it.each([
    ["desktop-wide floating", 1280, 1200, false],
    ["narrow floating", 1280, 600, true],
    ["mobile viewport", 390, 390, true],
  ])("commits the requested thread before its session list resolves on %s", (_surface, viewportWidth, width, narrow) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: viewportWidth });
    floatingWidth = width;
    fetchChatSessions.mockReturnValue(deferred<{ sessions: ReturnType<typeof session>[] }>().promise);

    renderWindows();

    expect(screen.getByText("Requested thread")).toBeInTheDocument();
    expect(document.querySelector(".chat-view")).toHaveClass("chat-view--detail");
    expect(document.querySelector(".chat-view")?.classList.contains("chat-view--narrow")).toBe(narrow);
    expect(document.querySelector(".chat-sidebar")).toHaveClass("chat-sidebar--hidden");
    expect(document.querySelector(".chat-thread")).toBeInTheDocument();
    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
    expect(navigation.pushNav).not.toHaveBeenCalled();
  });

  it("commits the requested thread before its session list resolves in the compact host", () => {
    floatingWidth = 600;
    fetchChatSessions.mockReturnValue(deferred<{ sessions: ReturnType<typeof session>[] }>().promise);

    render(
      <ChatView
        projectId="project-a"
        addToast={vi.fn()}
        compactLayout
        initialDirectSession={session()}
        initialDirectSessionNonce={1}
        persistChatPreferences={false}
        onOpenSessionInNewWindow={vi.fn()}
      />,
    );

    expect(document.querySelector(".chat-view")).toHaveClass("chat-view--detail");
    expect(document.querySelector(".chat-sidebar")).toHaveClass("chat-sidebar--hidden");
    expect(document.querySelector(".chat-thread")).toBeInTheDocument();
    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
    expect(navigation.pushNav).not.toHaveBeenCalled();
  });

  it("keeps the requested thread open when the session-list refresh rejects", async () => {
    fetchChatSessions.mockRejectedValueOnce(new Error("offline"));

    renderWindows();
    await act(async () => {});

    expect(screen.getByText("Requested thread")).toBeInTheDocument();
    expect(document.querySelector(".chat-view")).toHaveClass("chat-view--detail");
    expect(document.querySelector(".chat-sidebar")).toHaveClass("chat-sidebar--hidden");
    expect(document.querySelector(".chat-thread")).toBeInTheDocument();
    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
    expect(navigation.pushNav).not.toHaveBeenCalled();
  });

  it("uses a new focus nonce to reopen the same overlay after Back without pushing navigation", () => {
    fetchChatSessions.mockReturnValue(deferred<{ sessions: ReturnType<typeof session>[] }>().promise);
    const { rerender } = renderWindows([entry("requested-thread", 1)]);
    const overlay = screen.getByTestId("floating-window-overlay-chat-window-project-a-requested-thread");

    fireEvent.click(screen.getByTestId("chat-back-btn"));
    expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-thread-header-identity")).not.toBeInTheDocument();

    rerender(<PoppedOutChatWindows entries={[entry("requested-thread", 1)]} projectId="project-a" addToast={vi.fn()} onClose={vi.fn()} onOpenSessionInNewWindow={vi.fn()} />);
    expect(screen.queryByTestId("chat-thread-header-identity")).not.toBeInTheDocument();

    rerender(<PoppedOutChatWindows entries={[entry("requested-thread", 2)]} projectId="project-a" addToast={vi.fn()} onClose={vi.fn()} onOpenSessionInNewWindow={vi.fn()} />);
    expect(screen.getByTestId("floating-window-overlay-chat-window-project-a-requested-thread")).toBe(overlay);
    expect(screen.getByText("Requested thread")).toBeInTheDocument();
    expect(navigation.pushNav).not.toHaveBeenCalled();
  });

  it("keeps a newly created requested session selected when the pending list omits it", async () => {
    const pendingSessions = deferred<{ sessions: ReturnType<typeof session>[] }>();
    fetchChatSessions.mockReturnValueOnce(pendingSessions.promise);

    renderWindows([entry("new-session")]);
    expect(screen.getByText("Requested thread")).toBeInTheDocument();

    await act(async () => {
      pendingSessions.resolve({ sessions: [session("older-session", "Older thread")] });
    });

    expect(screen.getByText("Requested thread")).toBeInTheDocument();
    expect(screen.queryByText("Older thread")).toBeInTheDocument();
    expect(navigation.pushNav).not.toHaveBeenCalled();
  });
});
