import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  const originalVisualViewport = window.visualViewport;

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

  afterEach(() => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: originalVisualViewport,
      writable: true,
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

  it("disables recipient select when agents list is empty", () => {
    render(<MessageComposer {...defaultProps} />);
    const select = screen.getByTestId("message-composer-recipient");
    expect(select).toBeDefined();
    expect(select.tagName).toBe("SELECT");
    expect(select.hasAttribute("disabled")).toBe(true);
    expect(select.textContent).toContain("No agents available");
  });

  it("shows loading state in recipient select", () => {
    render(<MessageComposer {...defaultProps} isLoadingAgents={true} />);
    const select = screen.getByTestId("message-composer-recipient");
    expect(select).toBeDefined();
    expect(select.tagName).toBe("SELECT");
    expect(select.hasAttribute("disabled")).toBe(true);
    expect(select.textContent).toContain("Loading agents…");
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

  it("auto-focuses textarea when reply context is provided", () => {
    render(
      <MessageComposer
        {...defaultProps}
        recipient={{ id: "agent-001", type: "agent" }}
        replyContext={{ messageId: "m1", preview: "Previous" }}
      />,
    );

    expect(document.activeElement).toBe(screen.getByTestId("message-composer-content"));
  });

  it("scrolls textarea into view on visualViewport resize when replying", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    let resizeHandler: (() => void) | undefined;

    addEventListener.mockImplementation((event: string, handler: () => void) => {
      if (event === "resize") {
        resizeHandler = handler;
      }
    });

    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        addEventListener,
        removeEventListener,
      },
      writable: true,
    });

    if (!("scrollIntoView" in HTMLElement.prototype)) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: () => undefined,
        writable: true,
      });
    }
    const scrollIntoViewSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);

    render(
      <MessageComposer
        {...defaultProps}
        recipient={{ id: "agent-001", type: "agent" }}
        replyContext={{ messageId: "m1", preview: "Previous" }}
      />,
    );

    expect(addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    resizeHandler?.();
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "center", behavior: "auto" });

    scrollIntoViewSpy.mockRestore();
  });

  it("does not throw when visualViewport is unavailable", () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
      writable: true,
    });

    expect(() => {
      render(
        <MessageComposer
          {...defaultProps}
          recipient={{ id: "agent-001", type: "agent" }}
          replyContext={{ messageId: "m1", preview: "Previous" }}
        />,
      );
    }).not.toThrow();
  });

  it("shows pre-filled recipient agent name when recipient id exists in agents list", () => {
    render(
      <MessageComposer
        {...defaultProps}
        agents={mockAgents}
        recipient={{ id: "agent-001", type: "agent" }}
      />,
    );

    expect(screen.getByText("Test Agent")).toBeDefined();
    expect(screen.queryByText("agent-001")).toBeNull();
  });

  it("falls back to pre-filled recipient id when agent is not in agents list", () => {
    render(
      <MessageComposer
        {...defaultProps}
        agents={mockAgents}
        recipient={{ id: "agent-missing", type: "agent" }}
      />,
    );

    expect(screen.getByText("agent-missing")).toBeDefined();
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

  it("forwards wakeImmediately when the wake checkbox is ticked for an agent recipient", async () => {
    render(<MessageComposer {...defaultProps} agents={mockAgents} />);
    fireEvent.change(screen.getByTestId("message-composer-recipient"), {
      target: { value: "agent-001" },
    });
    fireEvent.change(screen.getByTestId("message-composer-content"), {
      target: { value: "wake up" },
    });
    fireEvent.click(screen.getByTestId("message-composer-wake"));
    fireEvent.click(screen.getByTestId("message-composer-send"));

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          wakeImmediately: true,
        }),
        undefined,
      );
    });
  });

  it("sends wakeImmediately alongside replyTo metadata when replying", async () => {
    render(
      <MessageComposer
        {...defaultProps}
        agents={mockAgents}
        recipient={{ id: "agent-001", type: "agent" }}
        replyContext={{ messageId: "msg-orig", preview: "earlier message" }}
      />,
    );
    fireEvent.change(screen.getByTestId("message-composer-content"), {
      target: { value: "follow up" },
    });
    fireEvent.click(screen.getByTestId("message-composer-wake"));
    fireEvent.click(screen.getByTestId("message-composer-send"));

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          wakeImmediately: true,
          metadata: {
            replyTo: { messageId: "msg-orig" },
          },
        }),
        undefined,
      );
    });
  });

  it("omits wakeImmediately when the checkbox is left unchecked", async () => {
    render(<MessageComposer {...defaultProps} agents={mockAgents} />);
    fireEvent.change(screen.getByTestId("message-composer-recipient"), {
      target: { value: "agent-001" },
    });
    fireEvent.change(screen.getByTestId("message-composer-content"), {
      target: { value: "regular" },
    });
    fireEvent.click(screen.getByTestId("message-composer-send"));

    await waitFor(() => {
      const callArgs = mockSendMessage.mock.calls[0][0];
      expect(callArgs.wakeImmediately).toBeUndefined();
    });
  });

  it("locks wake checkbox as checked when selected agent is already immediate mode", () => {
    const immediateAgents: Agent[] = [
      {
        ...mockAgents[0],
        runtimeConfig: { messageResponseMode: "immediate" },
      },
    ];
    render(<MessageComposer {...defaultProps} agents={immediateAgents} />);
    fireEvent.change(screen.getByTestId("message-composer-recipient"), {
      target: { value: "agent-001" },
    });

    const wakeCheckbox = screen.getByTestId("message-composer-wake") as HTMLInputElement;
    expect(wakeCheckbox.checked).toBe(true);
    expect(wakeCheckbox.disabled).toBe(true);
    expect(screen.getByTestId("message-composer-wake-hint").textContent).toContain("already set to immediate response mode");
  });

  it("hides wake checkbox for non-agent recipients", () => {
    render(
      <MessageComposer
        {...defaultProps}
        agents={mockAgents}
        recipient={{ id: "dashboard", type: "user" }}
      />,
    );

    expect(screen.queryByTestId("message-composer-wake")).toBeNull();
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
