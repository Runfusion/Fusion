import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MessageComposer } from "../MessageComposer";
import * as apiModule from "../../api";
import type { Agent } from "../../api";

// Mock the API module
vi.mock("../../api", () => ({
  sendMessage: vi.fn(),
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  X: () => <span data-testid="icon-x">X</span>,
  Send: () => <span data-testid="icon-send">Send</span>,
  Loader2: ({ className }: { className?: string }) => (
    <span data-testid="icon-loader" className={className}>Loader</span>
  ),
  Bot: () => <span data-testid="icon-bot">Bot</span>,
  AlertCircle: () => <span data-testid="icon-alert">Alert</span>,
}));

const mockSendMessage = vi.mocked(apiModule.sendMessage);

const mockAgents: Agent[] = [
  {
    id: "agent-001",
    name: "Test Agent",
    role: "executor",
    state: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
];

const defaultProps = {
  onSend: vi.fn(),
  onCancel: vi.fn(),
  addToast: vi.fn(),
};

describe("MessageComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue({
      id: "msg-new",
      fromId: "dashboard",
      fromType: "user",
      toId: "agent-001",
      toType: "agent",
      content: "Test message",
      type: "user-to-agent",
      read: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  it("renders the composer with header", () => {
    render(<MessageComposer {...defaultProps} />);
    expect(screen.getByText("New Message")).toBeDefined();
  });

  it("shows agent dropdown when agents are provided", () => {
    render(<MessageComposer {...defaultProps} agents={mockAgents} />);
    const select = screen.getByTestId("message-composer-recipient");
    expect(select).toBeDefined();
    expect(select.tagName).toBe("SELECT");
  });

  it("shows text input when no agents provided", () => {
    render(<MessageComposer {...defaultProps} />);
    const input = screen.getByTestId("message-composer-recipient");
    expect(input.tagName).toBe("INPUT");
  });

  it("disables send button when content is empty", () => {
    render(<MessageComposer {...defaultProps} agents={mockAgents} />);
    const sendBtn = screen.getByTestId("message-composer-send");
    expect(sendBtn.hasAttribute("disabled")).toBe(true);
  });

  it("enables send button when recipient and content are filled", () => {
    render(<MessageComposer {...defaultProps} agents={mockAgents} />);
    // Select agent
    fireEvent.change(screen.getByTestId("message-composer-recipient"), {
      target: { value: "agent-001" },
    });
    // Type content
    fireEvent.change(screen.getByTestId("message-composer-content"), {
      target: { value: "Hello agent!" },
    });
    const sendBtn = screen.getByTestId("message-composer-send");
    expect(sendBtn.hasAttribute("disabled")).toBe(false);
  });

  it("shows character count", () => {
    render(<MessageComposer {...defaultProps} />);
    expect(screen.getByTestId("message-composer-charcount")).toBeDefined();
    expect(screen.getByTestId("message-composer-charcount").textContent).toContain("0/2000");
  });

  it("updates character count when typing", () => {
    render(<MessageComposer {...defaultProps} />);
    const textarea = screen.getByTestId("message-composer-content");
    fireEvent.change(textarea, { target: { value: "Hello" } });
    expect(screen.getByTestId("message-composer-charcount").textContent).toContain("5/2000");
  });

  it("calls onSend when message is sent successfully", async () => {
    render(<MessageComposer {...defaultProps} agents={mockAgents} />);
    fireEvent.change(screen.getByTestId("message-composer-recipient"), {
      target: { value: "agent-001" },
    });
    fireEvent.change(screen.getByTestId("message-composer-content"), {
      target: { value: "Hello agent!" },
    });
    fireEvent.click(screen.getByTestId("message-composer-send"));
    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        {
          toId: "agent-001",
          toType: "agent",
          content: "Hello agent!",
          type: "user-to-agent",
        },
        undefined,
      );
    });
    expect(defaultProps.onSend).toHaveBeenCalledOnce();
  });

  it("shows error when send fails", async () => {
    mockSendMessage.mockRejectedValue(new Error("Network error"));
    render(<MessageComposer {...defaultProps} agents={mockAgents} />);
    fireEvent.change(screen.getByTestId("message-composer-recipient"), {
      target: { value: "agent-001" },
    });
    fireEvent.change(screen.getByTestId("message-composer-content"), {
      target: { value: "Hello agent!" },
    });
    fireEvent.click(screen.getByTestId("message-composer-send"));
    await waitFor(() => {
      expect(screen.getByTestId("message-composer-error")).toBeDefined();
    });
    expect(screen.getByTestId("message-composer-error").textContent).toContain("Network error");
  });

  it("calls onCancel when clicking cancel button", () => {
    render(<MessageComposer {...defaultProps} />);
    fireEvent.click(screen.getByTestId("message-composer-cancel"));
    expect(defaultProps.onCancel).toHaveBeenCalledOnce();
  });

  it("calls onCancel when clicking cancel footer button", () => {
    render(<MessageComposer {...defaultProps} />);
    fireEvent.click(screen.getByTestId("message-composer-cancel-btn"));
    expect(defaultProps.onCancel).toHaveBeenCalledOnce();
  });

  it("pre-fills recipient when provided", () => {
    render(
      <MessageComposer
        {...defaultProps}
        recipient={{ id: "agent-001", type: "agent" }}
      />,
    );
    // When recipient is pre-filled, it shows a fixed label instead of dropdown
    expect(screen.getByText("agent-001")).toBeDefined();
  });

  it("shows loading state while sending", async () => {
    mockSendMessage.mockImplementation(() => new Promise(() => {})); // Never resolves
    render(<MessageComposer {...defaultProps} agents={mockAgents} />);
    fireEvent.change(screen.getByTestId("message-composer-recipient"), {
      target: { value: "agent-001" },
    });
    fireEvent.change(screen.getByTestId("message-composer-content"), {
      target: { value: "Hello agent!" },
    });
    fireEvent.click(screen.getByTestId("message-composer-send"));
    await waitFor(() => {
      expect(screen.getByTestId("icon-loader")).toBeDefined();
    });
  });

  it("passes projectId to sendMessage", async () => {
    render(<MessageComposer {...defaultProps} agents={mockAgents} projectId="proj-1" />);
    fireEvent.change(screen.getByTestId("message-composer-recipient"), {
      target: { value: "agent-001" },
    });
    fireEvent.change(screen.getByTestId("message-composer-content"), {
      target: { value: "Hello!" },
    });
    fireEvent.click(screen.getByTestId("message-composer-send"));
    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.anything(),
        "proj-1",
      );
    });
  });
});
