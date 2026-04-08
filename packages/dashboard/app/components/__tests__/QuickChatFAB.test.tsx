import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Message } from "@fusion/core";
import type { Agent } from "../../api";
import * as apiModule from "../../api";
import { useAgents } from "../../hooks/useAgents";
import { QuickChatFAB } from "../QuickChatFAB";

vi.mock("../../api", () => ({
  fetchConversation: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../../hooks/useAgents", () => ({
  useAgents: vi.fn(),
}));

const mockFetchConversation = vi.mocked(apiModule.fetchConversation);
const mockSendMessage = vi.mocked(apiModule.sendMessage);
const mockUseAgents = vi.mocked(useAgents);

const mockAgents: Agent[] = [
  {
    id: "agent-001",
    name: "Agent One",
    role: "executor",
    state: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
  {
    id: "agent-002",
    name: "Agent Two",
    role: "reviewer",
    state: "terminated",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
];

const mockConversation: Message[] = [
  {
    id: "msg-001",
    fromId: "agent-001",
    fromType: "agent",
    toId: "dashboard",
    toType: "user",
    content: "Hello from the agent",
    type: "agent-to-user",
    read: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "msg-002",
    fromId: "dashboard",
    fromType: "user",
    toId: "agent-001",
    toType: "agent",
    content: "Hello back",
    type: "user-to-agent",
    read: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

function mockAgentsHook(agents: Agent[], isLoading = false) {
  mockUseAgents.mockReturnValue({
    agents,
    activeAgents: agents.filter((agent) => agent.state === "active" || agent.state === "running"),
    stats: null,
    isLoading,
    loadAgents: vi.fn(),
    loadStats: vi.fn(),
  });
}

describe("QuickChatFAB", () => {
  const addToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentsHook(mockAgents);
    mockFetchConversation.mockResolvedValue(mockConversation);
    mockSendMessage.mockResolvedValue({
      id: "msg-003",
      fromId: "dashboard",
      fromType: "user",
      toId: "agent-001",
      toType: "agent",
      content: "New message",
      type: "user-to-agent",
      read: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  it("renders nothing when no agents exist", () => {
    mockAgentsHook([]);

    render(<QuickChatFAB addToast={addToast} />);

    expect(screen.queryByTestId("quick-chat-fab")).toBeNull();
  });

  it("renders FAB button when agents exist", () => {
    render(<QuickChatFAB addToast={addToast} />);

    expect(screen.getByTestId("quick-chat-fab")).toBeDefined();
  });

  it("opens chat panel when FAB is clicked", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });
  });

  it("closes panel via close button and Escape key", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("quick-chat-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-panel")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-panel")).toBeNull();
    });
  });

  it("shows available agents in selector", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const select = await screen.findByTestId("quick-chat-agent-select");
    expect(select).toBeDefined();
    expect(screen.getByRole("option", { name: "Agent One (executor)" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Agent Two (reviewer)" })).toBeDefined();
  });

  it("sending a message calls sendMessage API with expected params", async () => {
    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "Ship it" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        {
          toId: "agent-001",
          toType: "agent",
          content: "Ship it",
          type: "user-to-agent",
        },
        "proj-123",
      );
    });

    await waitFor(() => {
      expect((screen.getByTestId("quick-chat-input") as HTMLInputElement).value).toBe("");
    });
  });

  it("switching agents loads the selected conversation", async () => {
    mockFetchConversation.mockResolvedValue([]);
    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(mockFetchConversation).toHaveBeenCalledWith("agent-001", "agent", "proj-123");
    });

    fireEvent.change(screen.getByTestId("quick-chat-agent-select"), {
      target: { value: "agent-002" },
    });

    await waitFor(() => {
      expect(mockFetchConversation).toHaveBeenCalledWith("agent-002", "agent", "proj-123");
    });
  });

  it("shows placeholder text when conversation is empty", async () => {
    mockFetchConversation.mockResolvedValue([]);
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByText("No messages yet. Start the conversation!")).toBeDefined();
    });
  });

  it("closes panel when clicking outside", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });

    fireEvent.mouseDown(document.body);
    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-panel")).toBeNull();
    });
  });
});
