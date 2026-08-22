/*
FNXC:ChatNavigation 2026-08-19-20:54:
FN-054 replaces the mobile session switcher with the same list-to-detail state machine used by every Chat host. These focused phone assertions protect the user-visible invariant: restored metadata stays list-first, selection opens one thread pane, and Back is the only in-detail return control.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import {
  activeSessionFixture,
  createRoomFixture,
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", () => ({
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));

describe("ChatView mobile list/detail navigation", () => {
  beforeEach(() => {
    installChatViewEnv();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a restored Direct session in the full-pane list until the user selects it", async () => {
    const viewportSpy = mockViewportMode("mobile");
    setupMockChat({
      activeSession: activeSessionFixture,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
    });
    setupMockRooms();

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sidebar = document.querySelector(".chat-sidebar") as HTMLElement;
    expect(sidebar).not.toHaveClass("chat-sidebar--hidden");
    expect(screen.queryByTestId("chat-back-btn")).toBeNull();
    expect(screen.queryByTestId("chat-mobile-session-trigger")).toBeNull();

    await userEvent.click(screen.getByTestId("chat-session-session-001"));

    expect(sidebar).toHaveClass("chat-sidebar--hidden");
    const back = screen.getByTestId("chat-back-btn");
    expect(back).toHaveAccessibleName("Back to conversations");
    expect(back).toHaveTextContent("< BACK");
    expect(back.closest(".chat-thread-header")).toBeInTheDocument();
    expect(back.closest(".view-header")).toBeNull();
    expect(screen.getAllByTestId("chat-back-btn")).toHaveLength(1);
    expect(screen.queryByTestId("chat-mobile-session-trigger")).toBeNull();
    expect(document.querySelectorAll(".view-header [data-testid='chat-new-btn']")).toHaveLength(1);
    expect(document.querySelector(".chat-thread-new-chat-btn")).toBeNull();

    await userEvent.click(back);
    expect(sidebar).not.toHaveClass("chat-sidebar--hidden");
    expect(screen.queryByTestId("chat-back-btn")).toBeNull();
    viewportSpy.mockRestore();
  });

  it("uses the same Back-only detail navigation for Rooms", async () => {
    const viewportSpy = mockViewportMode("mobile");
    const room = createRoomFixture("ops");
    localStorage.setItem("fusion:chat-scope", "rooms");
    setupMockChat({ sessions: [], filteredSessions: [] });
    setupMockRooms({ rooms: [room], activeRoom: room });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-room-item-ops"));
    expect(screen.getByTestId("chat-back-btn")).toHaveAccessibleName("Back to conversations");
    expect(screen.queryByTestId("chat-mobile-session-trigger")).toBeNull();
    expect(document.querySelectorAll(".view-header [data-testid='chat-new-btn']")).toHaveLength(1);

    await userEvent.click(screen.getByTestId("chat-new-btn"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(document.querySelector(".chat-new-dialog-backdrop") as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("chat-back-btn"));
    expect(screen.getByTestId("chat-room-item-ops")).toBeInTheDocument();
    viewportSpy.mockRestore();
  });

  it("keeps narrow floating Chat on the shared list-to-detail flow", async () => {
    const viewportSpy = mockViewportMode("mobile");
    setupMockChat({
      activeSession: activeSessionFixture,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
    });
    setupMockRooms();

    const onClose = vi.fn();
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} floating onClose={onClose} />);
    await userEvent.click(screen.getByTestId("chat-session-session-001"));

    expect(document.querySelector(".chat-view--narrow .chat-sidebar")).toHaveClass("chat-sidebar--hidden");
    const back = screen.getByTestId("chat-back-btn");
    expect(back.closest(".chat-thread-header")).toBeInTheDocument();
    expect(screen.getAllByTestId("chat-back-btn")).toHaveLength(1);
    expect(screen.queryByTestId("chat-mobile-session-trigger")).toBeNull();
    expect(document.querySelectorAll(".view-header [data-testid='chat-new-btn']")).toHaveLength(1);
    expect(screen.getByTestId("chat-modal-close")).toBeInTheDocument();
    expect(document.querySelector(".chat-thread-new-chat-btn")).toBeNull();
    viewportSpy.mockRestore();
  });
});
