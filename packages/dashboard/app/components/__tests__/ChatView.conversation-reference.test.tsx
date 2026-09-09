/*
FNXC:DashboardTests 2026-09-04-09:58:
Conversation ID copying must exercise the shared row menu through desktop right-click and compact touch triggers, including secure Clipboard API, fallback, and failure paths. This keeps every ChatView host on one affordance and proves the copied value is the stable ID rather than the display title.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import type { ChatSessionInfo } from "../../hooks/useChat";
import {
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({
    models: [],
    favoriteProviders: [],
    favoriteModels: [],
  }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();

const originalExecCommand = document.execCommand;
const referencedSession: ChatSessionInfo = {
  id: "chat-1a2b3c4d",
  agentId: "agent-001",
  status: "active",
  title: "Delivery status",
  createdAt: "2026-09-04T08:00:00.000Z",
  updatedAt: "2026-09-04T09:00:00.000Z",
};

function mockExecCommand(result: boolean) {
  const execCommand = vi.fn().mockReturnValue(result);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

function setupSession(session: ChatSessionInfo = referencedSession) {
  setupMockChat({
    sessions: [session],
    filteredSessions: [session],
    activeSession: session,
  });
}

async function renderAndOpenDesktopMenu(
  addToast = vi.fn(),
  session: ChatSessionInfo = referencedSession,
) {
  setupSession(session);
  await renderWithAct(<ChatView projectId="proj-123" addToast={addToast} />);
  fireEvent.contextMenu(screen.getByTestId(`chat-session-${session.id}`), {
    clientX: 20,
    clientY: 20,
  });
  return { addToast, copyButton: await screen.findByTestId("chat-context-copy-id") };
}

afterEach(() => {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: originalExecCommand,
  });
});

describe("ChatView conversation references", () => {
  it("copies the exact conversation ID from the desktop context menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { addToast, copyButton } = await renderAndOpenDesktopMenu();

    await userEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(referencedSession.id));
    expect(addToast).toHaveBeenCalledWith("Conversation ID copied");
    expect(screen.queryByTestId("chat-context-copy-id")).not.toBeInTheDocument();
  });

  it("copies the same ID from the compact three-dot menu", async () => {
    mockViewportMode("mobile");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const addToast = vi.fn();
    setupSession();
    await renderWithAct(<ChatView projectId="proj-123" addToast={addToast} />);

    await userEvent.click(screen.getByTestId("chat-session-menu-btn"));
    await userEvent.click(await screen.findByTestId("chat-context-copy-id"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(referencedSession.id));
    expect(addToast).toHaveBeenCalledWith("Conversation ID copied");
  });

  it("copies the ID for an untitled conversation", async () => {
    const untitled = { ...referencedSession, title: null };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { copyButton } = await renderAndOpenDesktopMenu(vi.fn(), untitled);

    expect(screen.getByTestId(`chat-session-${untitled.id}`)).toHaveTextContent("Untitled");
    await userEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(untitled.id));
    expect(writeText).not.toHaveBeenCalledWith("Untitled");
  });

  it("keeps copy available for archived conversation rows", async () => {
    const archived = { ...referencedSession, status: "archived" as const };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    setupMockChat({
      sessions: [],
      filteredSessions: [],
      activeSession: null,
      archivedSessions: [archived],
    });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-archived-toggle"));
    fireEvent.contextMenu(await screen.findByTestId(`chat-archived-session-${archived.id}`), {
      clientX: 20,
      clientY: 20,
    });
    await userEvent.click(await screen.findByTestId("chat-context-copy-id"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(archived.id));
  });

  it("uses the execCommand fallback when navigator.clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const execCommand = mockExecCommand(true);
    const { addToast, copyButton } = await renderAndOpenDesktopMenu();

    await userEvent.click(copyButton);

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(addToast).toHaveBeenCalledWith("Conversation ID copied");
  });

  it("shows an error toast when Clipboard API and fallback both fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execCommand = mockExecCommand(false);
    const { addToast, copyButton } = await renderAndOpenDesktopMenu();

    await userEvent.click(copyButton);

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(addToast).toHaveBeenCalledWith("Copy failed", "error");
  });

  it("retains every existing conversation management entry", async () => {
    const { copyButton } = await renderAndOpenDesktopMenu();

    expect(copyButton).toHaveTextContent("Copy conversation ID");
    for (const testId of [
      "chat-context-pin",
      "chat-context-rename",
      "chat-context-archive",
      "chat-context-delete",
    ]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
  });

  it("suggests another loaded conversation and inserts its full ID", async () => {
    const currentSession: ChatSessionInfo = {
      ...referencedSession,
      id: "chat-current1",
      title: "Current conversation",
    };
    setupMockChat({
      sessions: [currentSession, referencedSession],
      filteredSessions: [currentSession, referencedSession],
      activeSession: currentSession,
    });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await userEvent.click(screen.getByTestId(`chat-session-${currentSession.id}`));
    const input = await screen.findByTestId("chat-input") as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: "#chat", selectionStart: 5, selectionEnd: 5 },
    });

    expect(await screen.findByText("Conversations")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-mention-item-0")).toHaveTextContent(referencedSession.id);
    expect(screen.queryByText(currentSession.id)).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input.value).toBe(`#${referencedSession.id}`));
  });
});
