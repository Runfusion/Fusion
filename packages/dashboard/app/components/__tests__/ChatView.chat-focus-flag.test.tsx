import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import * as api from "../../api";
import {
  activeSessionFixture,
  defaultChatState,
  installChatViewEnv,
  mockViewportMode,
  renderChatDetailWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }),
}));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));
vi.mock("../ChatFocusSelector", () => ({
  ChatFocusSelector: () => <button type="button" data-testid="chat-focus-chip" aria-label="Memory focus topic" />,
}));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn(),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  updateChatSession: vi.fn().mockResolvedValue({}),
}));

installChatViewEnv();

const mockFetchSettings = vi.mocked(api.fetchSettings);
const mockUpdateChatSession = vi.mocked(api.updateChatSession);
const commandContext = { taskId: "FN-9209", projectId: "proj-123", agentRunning: true };

async function renderFocusedChat() {
  const session = { ...activeSessionFixture, id: "focus-session" };
  setupMockChat({
    ...defaultChatState,
    activeSession: session,
    sessions: [session],
    filteredSessions: [session],
  });
  setupMockRooms();
  await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} chatCommandContext={commandContext} />);
}

describe("ChatView chat focus experimental flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSettings.mockResolvedValue({} as Awaited<ReturnType<typeof api.fetchSettings>>);
    vi.mocked(api.fetchChatSession).mockResolvedValue({ session: { memoryFocus: null } } as Awaited<ReturnType<typeof api.fetchChatSession>>);
    localStorage.setItem("fusion:chat-scope", "direct");
    mockViewportMode("desktop");
  });

  it("defaults off, including for a session with persisted focus", async () => {
    vi.mocked(api.fetchChatSession).mockResolvedValue({ session: { memoryFocus: "auth-northstar" } } as Awaited<ReturnType<typeof api.fetchChatSession>>);
    await renderFocusedChat();

    expect(screen.queryByTestId("chat-focus-chip")).toBeNull();
    expect(screen.queryByRole("button", { name: "Memory focus topic" })).toBeNull();
  });

  it("renders the chip only after explicit opt-in", async () => {
    mockFetchSettings.mockResolvedValue({ experimentalFeatures: { chatFocus: true } } as Awaited<ReturnType<typeof api.fetchSettings>>);
    await renderFocusedChat();

    expect(await screen.findByTestId("chat-focus-chip")).toBeInTheDocument();
  });

  it("fails closed when the settings request rejects", async () => {
    mockFetchSettings.mockRejectedValue(new Error("settings unavailable"));
    await renderFocusedChat();

    await Promise.resolve();
    expect(screen.queryByTestId("chat-focus-chip")).toBeNull();
  });

  it("withholds and refuses /focus while preserving /steer when off", async () => {
    await renderFocusedChat();
    const input = screen.getByTestId("chat-input");
    fireEvent.change(input, { target: { value: "/" } });

    expect(await screen.findByText("/steer")).toBeInTheDocument();
    expect(screen.queryByText("/focus")).toBeNull();

    fireEvent.change(input, { target: { value: "/focus auth-northstar" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(mockUpdateChatSession).not.toHaveBeenCalled();
  });

  it("restores /focus menu and submit dispatch after opt-in", async () => {
    mockFetchSettings.mockResolvedValue({ experimentalFeatures: { chatFocus: true } } as Awaited<ReturnType<typeof api.fetchSettings>>);
    await renderFocusedChat();
    const input = screen.getByTestId("chat-input");
    fireEvent.change(input, { target: { value: "/" } });

    expect(await screen.findByText("/focus")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "/focus auth-northstar" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(mockUpdateChatSession).toHaveBeenCalledWith("focus-session", { memoryFocus: "auth-northstar" }, "proj-123");
  });

  it("keeps the focus chip out of the narrow mobile composer", async () => {
    mockViewportMode("mobile");
    await renderFocusedChat();

    expect(screen.queryByTestId("chat-focus-chip")).toBeNull();
    expect(document.querySelector(".chat-input-row [data-testid='chat-focus-chip']")).toBeNull();
  });
});
