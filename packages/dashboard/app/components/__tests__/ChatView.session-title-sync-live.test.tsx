/*
FNXC:ChatWindows 2026-09-18-01:28:
FN-524: the operator reported the conversation list showing the new name while the OPEN conversation
header kept the old one. Every pre-existing header test mounts a MOCKED `useChat`, so the list rows
and the active session come from one fixture and a divergence between the two writers is
structurally invisible there. This suite mounts the REAL hook: the list row and the header are
asserted in the SAME render tree, driven by real `chat:session:updated` events, the real rename
dialog, and the real detached-window host.
*/

import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useEffect } from "react";
import type { ChatSessionInfo } from "../../hooks/useChat";

const { sseHandlers } = vi.hoisted(() => ({
  sseHandlers: { current: {} as Record<string, (event: MessageEvent) => void> },
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, options: { events?: Record<string, (e: MessageEvent) => void> }) => {
    if (options?.events) sseHandlers.current = { ...sseHandlers.current, ...options.events };
    return () => {};
  }),
}));

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
  getPersistedChatOpenSession: vi.fn(),
  setPersistedChatOpenSession: vi.fn(),
  clearPersistedChatOpenSession: vi.fn(),
}));

vi.mock("../../api", () => ({
  // useChat's surface
  fetchChatSessions: vi.fn(),
  fetchChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  fetchChatTags: vi.fn(),
  createChatSession: vi.fn(),
  updateChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  backfillChatSessionToStash: vi.fn(),
  attachChatStream: vi.fn(() => ({ close: vi.fn() })),
  streamChatResponse: vi.fn(() => ({ close: vi.fn() })),
  cancelChatResponse: vi.fn(),
  createChatTag: vi.fn(),
  renameChatTag: vi.fn(),
  deleteChatTag: vi.fn(),
  // ChatView's surface
  fetchSettings: vi.fn(),
  fetchModels: vi.fn(),
  fetchAgents: vi.fn(),
  fetchDiscoveredSkills: vi.fn(),
  fetchTasks: vi.fn(),
  searchFiles: vi.fn(),
}));

vi.mock("../../hooks/useChatRooms", () => ({
  useChatRooms: () => ({
    rooms: [],
    roomsLoading: false,
    roomsError: null,
    activeRoom: null,
    activeRoomMembers: [],
    messages: [],
    messagesLoading: false,
    selectRoom: vi.fn(),
    createRoom: vi.fn(),
    deleteRoom: vi.fn(),
    sendRoomMessage: vi.fn(),
    refreshRooms: vi.fn(),
  }),
}));

vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }),
}));

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));

vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));

import { ChatView } from "../ChatView";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";
import { usePoppedOutChats } from "../../hooks/usePoppedOutChats";
import * as apiModule from "../../api";

const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockFetchChatSession = vi.mocked(apiModule.fetchChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockFetchChatTags = vi.mocked(apiModule.fetchChatTags);
const mockUpdateChatSession = vi.mocked(apiModule.updateChatSession);

function sessionFixture(id: string, title: string | null, overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo {
  return {
    id,
    agentId: "__fn_agent__",
    status: "active",
    title,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  } as ChatSessionInfo;
}

function emitSessionUpdated(session: unknown): void {
  act(() => {
    sseHandlers.current["chat:session:updated"]?.({ data: JSON.stringify(session) } as MessageEvent);
  });
}

/** A `fetchChatSession` promise the test resolves by hand, mirroring the hook suite's harness. */
function deferredSessionRead(): { resolve: (session: unknown) => void } {
  let resolveFn!: (value: unknown) => void;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  mockFetchChatSession.mockReturnValue(promise as never);
  return {
    resolve: (session) => {
      resolveFn({ session });
    },
  };
}

/*
FNXC:DashboardTests 2026-09-18-01:28:
jsdom reports a zero-width rect and installs an inert ResizeObserver, so any host is measured narrow
unless its width is stubbed. A "desktop" case without this stub silently exercises the narrow branch.
*/
function withMeasuredHost(width: number) {
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width, height: 720, top: 0, right: width, bottom: 720, left: 0, toJSON: () => ({}),
  });
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  const matchMediaSpy = vi.spyOn(window, "matchMedia").mockImplementation((query: string = "") => ({
    matches: width <= 768 && query.includes("max-width: 768px"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as MediaQueryList);
  return () => {
    rectSpy.mockRestore();
    matchMediaSpy.mockRestore();
  };
}

function headerTitleText(): string {
  return document.querySelector(".chat-view .view-header__title-content")?.textContent ?? "";
}

function listRowText(id: string): string {
  return screen.getByTestId(`chat-session-${id}`).textContent ?? "";
}

function resetEnv() {
  vi.clearAllMocks();
  localStorage.clear();
  sseHandlers.current = {};
  Element.prototype.scrollIntoView = vi.fn();
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { writable: true, configurable: true, value: vi.fn(() => ({
      matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })) });
  }
  mockFetchChatMessages.mockResolvedValue({ messages: [] } as never);
  mockFetchChatTags.mockResolvedValue({ tags: [] } as never);
  vi.mocked(apiModule.fetchSettings).mockResolvedValue({} as never);
  vi.mocked(apiModule.fetchModels).mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] } as never);
  vi.mocked(apiModule.fetchAgents).mockResolvedValue([] as never);
  vi.mocked(apiModule.fetchDiscoveredSkills).mockResolvedValue([] as never);
  vi.mocked(apiModule.fetchTasks).mockResolvedValue([] as never);
  vi.mocked(apiModule.searchFiles).mockResolvedValue({ files: [] } as never);
}

async function renderChatViewWithOpenConversation(sessions: ChatSessionInfo[], openId: string) {
  mockFetchChatSessions.mockResolvedValue({ sessions } as never);
  const user = userEvent.setup({ delay: null });
  const rendered = render(<ChatView projectId="proj-1" addToast={vi.fn()} />);
  await screen.findByTestId(`chat-session-${openId}`);
  await user.click(screen.getByTestId(`chat-session-${openId}`));
  await screen.findByTestId("chat-thread-title-trigger");
  return { ...rendered, user };
}

const BREAKPOINTS = [["desktop", 1280], ["mobile", 390]] as const;

describe("ChatView + real useChat — the list row and the open conversation header converge", () => {
  beforeEach(resetEnv);

  /*
   * (a) The reported symptom on the rendered surfaces: a generated title arrives while the
   * authoritative selection snapshot is still in flight, and that snapshot then resolves for a
   * DIFFERENT session id — the branch that used to discard the deferred title outright.
   */
  it.each(BREAKPOINTS)(
    "shows a generated title in both the list row and the thread header on %s",
    async (_mode, width) => {
      const restore = withMeasuredHost(width);
      try {
        const untitled = sessionFixture("session-001", null);
        mockFetchChatSessions.mockResolvedValue({ sessions: [untitled] } as never);
        const pending = deferredSessionRead();
        const user = userEvent.setup({ delay: null });
        render(<ChatView projectId="proj-1" addToast={vi.fn()} />);
        await screen.findByTestId("chat-session-session-001");
        await user.click(screen.getByTestId("chat-session-session-001"));
        await screen.findByTestId("chat-thread-title-trigger");
        expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Untitled conversation");

        emitSessionUpdated(sessionFixture("session-001", "Titre généré"));
        await act(async () => {
          pending.resolve(sessionFixture("session-autre", "Titre étranger"));
          await Promise.resolve();
        });

        await waitFor(() => {
          expect(listRowText("session-001")).toContain("Titre généré");
          expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Titre généré");
        });
        expect(screen.getByTestId("chat-thread-title-trigger")).not.toHaveTextContent("Untitled conversation");
      } finally {
        restore();
      }
    },
  );

  /*
   * (d) A CLEARED title is a rename too. Both the list row and the header must drop the old name:
   * the header falls back to the untitled label instead of resurrecting it.
   */
  it.each(BREAKPOINTS)(
    "drops a cleared title from both the list row and the thread header on %s",
    async (_mode, width) => {
      const restore = withMeasuredHost(width);
      try {
        const named = sessionFixture("session-001", "Ancien titre");
        mockFetchChatSessions.mockResolvedValue({ sessions: [named] } as never);
        const pending = deferredSessionRead();
        const user = userEvent.setup({ delay: null });
        render(<ChatView projectId="proj-1" addToast={vi.fn()} />);
        await screen.findByTestId("chat-session-session-001");
        await user.click(screen.getByTestId("chat-session-session-001"));
        await screen.findByTestId("chat-thread-title-trigger");

        emitSessionUpdated(sessionFixture("session-001", ""));
        await act(async () => {
          pending.resolve(sessionFixture("session-001", "Ancien titre"));
          await Promise.resolve();
        });

        await waitFor(() => {
          expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Untitled conversation");
        });
        expect(listRowText("session-001")).not.toContain("Ancien titre");
        expect(screen.getByTestId("chat-thread-title-trigger")).not.toHaveTextContent("Ancien titre");
      } finally {
        restore();
      }
    },
  );

  /*
   * (e) The real rename dialog: the operator renames the OPEN conversation, so the list row, the
   * header, and the header actions' accessible name must all carry the new name.
   */
  it.each(BREAKPOINTS)("follows a dialog rename in the list row, the header, and its accessible name on %s", async (_mode, width) => {
    const restore = withMeasuredHost(width);
    try {
      mockFetchChatSession.mockResolvedValue({ session: sessionFixture("session-001", "Ancien titre") } as never);
      mockUpdateChatSession.mockResolvedValue({
        session: sessionFixture("session-001", "Titre renommé", { updatedAt: "2026-09-17T10:00:00.000Z" }),
      } as never);
      const { user } = await renderChatViewWithOpenConversation([sessionFixture("session-001", "Ancien titre")], "session-001");

      await user.click(screen.getByTestId("chat-header-actions-btn"));
      await user.click(await screen.findByRole("menuitem", { name: /rename/i }));
      const input = await screen.findByTestId("chat-rename-input");
      await user.clear(input);
      await user.type(input, "Titre renommé");
      await user.click(screen.getByTestId("chat-rename-save"));

      await waitFor(() => {
        expect(listRowText("session-001")).toContain("Titre renommé");
        expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Titre renommé");
      });
      expect(screen.getByTestId("chat-header-actions-btn")).toHaveAttribute(
        "aria-label",
        expect.stringContaining("Titre renommé"),
      );
    } finally {
      restore();
    }
  });

  /*
   * (g) Duplicate names: selection and the header are bound to the session ID, never to the label.
   * Renaming the OTHER conversation must not retitle the open one.
   */
  it("keeps the header bound to the open conversation id when two conversations share a title", async () => {
    const restore = withMeasuredHost(1280);
    try {
      const first = sessionFixture("session-001", "Même nom");
      const second = sessionFixture("session-002", "Même nom", { updatedAt: "2026-09-16T00:00:00.000Z" });
      mockFetchChatSession.mockResolvedValue({ session: first } as never);
      const { user } = await renderChatViewWithOpenConversation([first, second], "session-001");
      expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Même nom");

      emitSessionUpdated(sessionFixture("session-002", "Autre nom", { updatedAt: "2026-09-16T00:00:00.000Z" }));

      await waitFor(() => expect(listRowText("session-002")).toContain("Autre nom"));
      expect(listRowText("session-001")).toContain("Même nom");
      expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Même nom");

      // The switcher menu still lists each conversation under its own identity.
      await user.click(screen.getByTestId("chat-thread-title-trigger"));
      expect(await screen.findByTestId("chat-thread-title-menu-item-session-002")).toHaveTextContent("Autre nom");
    } finally {
      restore();
    }
  });

  /*
   * (h) FN-505 contract preserved: a title landing mid-stream still reaches both surfaces without
   * disturbing the live conversation.
   */
  it("applies a title that lands while the conversation is streaming", async () => {
    const restore = withMeasuredHost(1280);
    try {
      const untitled = sessionFixture("session-001", null);
      mockFetchChatSession.mockResolvedValue({ session: untitled } as never);
      await renderChatViewWithOpenConversation([untitled], "session-001");

      emitSessionUpdated(sessionFixture("session-001", "Corrige le titre", { isGenerating: true } as Partial<ChatSessionInfo>));
      await waitFor(() => {
        expect(listRowText("session-001")).toContain("Corrige le titre");
        expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Corrige le titre");
      });

      emitSessionUpdated(sessionFixture("session-001", "Titre de conversation", { isGenerating: true } as Partial<ChatSessionInfo>));
      await waitFor(() => {
        expect(listRowText("session-001")).toContain("Titre de conversation");
        expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Titre de conversation");
      });
    } finally {
      restore();
    }
  });
});

/** Host mounting the real `usePoppedOutChats` registry with one detached conversation. */
function PoppedOutHost({ session }: { session: ChatSessionInfo }) {
  const popped = usePoppedOutChats();
  const { popOut } = popped;
  // Opening once is the whole fixture; re-raising the window is not part of this contract.
  useEffect(() => {
    popOut("proj-1", session);
  }, [popOut, session]);
  return (
    <PoppedOutChatWindows
      entries={popped.entries}
      projectId="proj-1"
      addToast={vi.fn()}
      onClose={vi.fn()}
      onOpenSessionInNewWindow={vi.fn()}
      onSessionSynced={popped.syncSession}
    />
  );
}

describe("PoppedOutChatWindows + real useChat — a detached conversation follows the live title", () => {
  beforeEach(resetEnv);

  // (f) The detached window: its ViewHeader title AND its accessible window name follow the rename.
  it("updates the dedicated window header and its accessible name from a session update", async () => {
    const restore = withMeasuredHost(1280);
    try {
      const initial = sessionFixture("session-001", "Ancien titre");
      mockFetchChatSessions.mockResolvedValue({ sessions: [initial] } as never);
      mockFetchChatSession.mockResolvedValue({ session: initial } as never);

      await act(async () => {
        render(<PoppedOutHost session={initial} />);
      });
      await waitFor(() => expect(headerTitleText()).toContain("Ancien titre"));

      emitSessionUpdated(sessionFixture("session-001", "Titre renommé", { updatedAt: "2026-09-17T10:00:00.000Z" }));

      await waitFor(() => expect(headerTitleText()).toContain("Titre renommé"));
      await waitFor(() =>
        expect(screen.getByTestId("floating-window-overlay-chat-window-proj-1-session-001")).toHaveAttribute(
          "aria-label",
          "Titre renommé",
        ),
      );
    } finally {
      restore();
    }
  });
});
