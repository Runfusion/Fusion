import { readAppFile } from "../../test/cssFixture";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import {
  activeSessionFixture,
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
} from "./ChatView.test-harness";

const { pushNav } = vi.hoisted(() => ({ pushNav: vi.fn() }));
const source = readAppFile("components/ChatView.tsx");

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav, removeNav: vi.fn() }),
  };
});
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: "", defaultModelId: "" }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();
afterEach(() => cleanup());

const popOutProps = {
  projectId: "proj-123",
  addToast: vi.fn(),
  floating: true,
  initialDirectSession: activeSessionFixture,
  persistChatPreferences: false,
};

function expectThreadOpen(options: { narrow?: boolean } = {}) {
  expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
  expect(document.querySelector(".chat-sidebar")).toHaveClass("chat-sidebar--hidden");
  expect(document.querySelector(".chat-view")).toHaveClass("chat-view--detail");
  if (options.narrow) {
    expect(document.querySelector(".chat-view")).toHaveClass("chat-view--narrow");
  } else {
    expect(document.querySelector(".chat-view")).not.toHaveClass("chat-view--narrow");
  }
}

/*
FNXC:ChatWindows 2026-08-23-04:12:
FN-169's pop-out contract is exercised through the rendered ChatView, rather than source
strings, because the user-visible invariant is a thread pane on arrival across every host shape.
*/
describe("ChatView direct-only UI contract", () => {
  it("keeps removed Rooms UI out of the direct chat surface", () => {
    expect(source).not.toContain("useChatRooms");
    expect(source).not.toContain("chatScope");
    expect(source).not.toContain("CreateRoomModal");
  });
});

describe("ChatView popped-out conversation contract", () => {
  it("opens the requested thread on desktop-wide, narrow floating, mobile, and compact hosts", async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 1200, height: 800, top: 0, right: 1200, bottom: 800, left: 0, toJSON: () => ({}),
    });
    try {
      setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
      await renderWithAct(<ChatView {...popOutProps} />);
      expectThreadOpen({ narrow: false });
    } finally {
      rectSpy.mockRestore();
      cleanup();
    }

    setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    await renderWithAct(<ChatView {...popOutProps} />);
    expectThreadOpen({ narrow: true });
    cleanup();

    mockViewportMode("mobile");
    setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    await renderWithAct(<ChatView {...popOutProps} />);
    expectThreadOpen({ narrow: true });
    cleanup();
    mockViewportMode("desktop");

    setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    await renderWithAct(<ChatView {...popOutProps} compactLayout />);
    expectThreadOpen({ narrow: true });
  });

  it("keeps ordinary hosts list-first and suppresses navigation for a delayed seeded selection", async () => {
    setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} persistChatPreferences={false} />);
    expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();
    expect(document.querySelector(".chat-sidebar")).not.toHaveClass("chat-sidebar--hidden");
    cleanup();

    /*
    FNXC:ChatWindows 2026-08-27-09:23:
    FN-193's real hook now exposes initialSession on the first commit. Keep this delayed mocked selection only to guard ChatView's automatic-detail navigation suppression if a future hook or degraded bridge resolves after paint.
    */
    pushNav.mockClear();
    setupMockChat({ activeSession: null, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    const { rerender } = await renderWithAct(<ChatView {...popOutProps} initialDirectSessionNonce={1} />);
    expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();

    setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    rerender(<ChatView {...popOutProps} initialDirectSessionNonce={1} />);
    await waitFor(() => expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument());
    expect(pushNav).not.toHaveBeenCalled();
  });

  it("renders an empty transcript and re-opens a different selected session on a nonce", async () => {
    const selectSession = vi.fn();
    const other = { ...activeSessionFixture, id: "session-other", title: "Other" };
    setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture, other], filteredSessions: [activeSessionFixture, other], messages: [], selectSession });
    const { rerender } = await renderWithAct(<ChatView {...popOutProps} initialDirectSessionNonce={1} />);
    expectThreadOpen({ narrow: true });
    fireEvent.click(screen.getByTestId("chat-back-btn"));
    expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();

    setupMockChat({ activeSession: other, sessions: [activeSessionFixture, other], filteredSessions: [activeSessionFixture, other], messages: [], selectSession });
    rerender(<ChatView {...popOutProps} initialDirectSessionNonce={2} />);
    await waitFor(() => expect(selectSession).toHaveBeenCalledWith(activeSessionFixture.id, activeSessionFixture));
    expectThreadOpen({ narrow: true });
  });

  it("does not reset an already active streaming session when a nonce re-opens it", async () => {
    const selectSession = vi.fn();
    setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture], isStreaming: true, streamingText: "replying", selectSession });
    const { rerender } = await renderWithAct(<ChatView {...popOutProps} initialDirectSessionNonce={1} />);
    fireEvent.click(screen.getByTestId("chat-back-btn"));
    rerender(<ChatView {...popOutProps} initialDirectSessionNonce={2} />);
    await waitFor(() => expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument());
    expect(selectSession).not.toHaveBeenCalled();
    expect(screen.getByText("replying")).toBeInTheDocument();
  });

  it("suppresses automatic navigation but records a manual drill-in after Back", async () => {
    pushNav.mockClear();
    setupMockChat({ activeSession: null, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    const { rerender } = await renderWithAct(<ChatView {...popOutProps} initialDirectSessionNonce={1} />);
    setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    rerender(<ChatView {...popOutProps} initialDirectSessionNonce={1} />);
    await waitFor(() => expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument());
    expect(pushNav).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("chat-back-btn"));
    fireEvent.click(screen.getByTestId(`chat-session-${activeSessionFixture.id}`));
    await waitFor(() => expect(pushNav).toHaveBeenCalledTimes(1));
  });

  it("retains the in-window controls and the open-in-new-window affordance", async () => {
    const onOpenSessionInNewWindow = vi.fn();
    setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    await renderWithAct(<ChatView {...popOutProps} onOpenSessionInNewWindow={onOpenSessionInNewWindow} />);
    expect(screen.getByTestId("chat-new-btn")).toBeInTheDocument();
    expect(screen.getByTestId("chat-back-btn")).toHaveAccessibleName("Back to conversations");
    expect(document.querySelector(".chat-sidebar")).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTestId(`chat-session-${activeSessionFixture.id}`), { clientX: 8, clientY: 8 });
    const open = await screen.findByTestId("chat-context-open-window");
    expect(open).toHaveTextContent("Open in new window");
    fireEvent.click(open);
    expect(onOpenSessionInNewWindow).toHaveBeenCalledWith(activeSessionFixture);
  });
});
