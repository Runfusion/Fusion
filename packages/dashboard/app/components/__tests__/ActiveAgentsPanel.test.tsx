import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ActiveAgentsPanel } from "../ActiveAgentsPanel";
import type { Agent } from "../../api";
import { useLiveTranscript } from "../../hooks/useLiveTranscript";

// Mock useLiveTranscript
vi.mock("../../hooks/useLiveTranscript", () => ({
  useLiveTranscript: vi.fn().mockReturnValue({
    entries: [],
    isConnected: false,
  }),
}));

const mockUseLiveTranscript = vi.mocked(useLiveTranscript);

describe("ActiveAgentsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });
  });

  it("renders live transcript text from entries", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [
        { type: "text", text: "Processing request...", timestamp: "2026-01-01T00:01:00Z" },
        { type: "text", text: "Analyzing code...", timestamp: "2026-01-01T00:02:00Z" },
      ],
      isConnected: true,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    render(<ActiveAgentsPanel agents={[mockAgent]} />);

    expect(screen.getByText("Processing request...")).toBeInTheDocument();
    expect(screen.getByText("Analyzing code...")).toBeInTheDocument();
  });

  it("passes projectId from props to useLiveTranscript hook", async () => {
    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    render(<ActiveAgentsPanel agents={[mockAgent]} projectId="my-project" />);

    // Verify the hook was called with the projectId
    expect(mockUseLiveTranscript).toHaveBeenCalledWith("FN-001", "my-project");
  });

  it("passes undefined projectId when not provided", async () => {
    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    render(<ActiveAgentsPanel agents={[mockAgent]} />);

    // Verify the hook was called without projectId
    expect(mockUseLiveTranscript).toHaveBeenCalledWith("FN-001", undefined);
  });

  it("renders empty state when no entries yet", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    render(<ActiveAgentsPanel agents={[mockAgent]} />);

    expect(screen.getByText("Connecting...")).toBeInTheDocument();
  });

  it("renders 'Waiting for output...' when connected but no entries", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: true,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    render(<ActiveAgentsPanel agents={[mockAgent]} />);

    expect(screen.getByText("Waiting for output...")).toBeInTheDocument();
  });

  it("shows idle copy (not 'Connecting...') when an active agent has no taskId", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "active",
      // taskId intentionally omitted — agent is available but not running
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    render(<ActiveAgentsPanel agents={[mockAgent]} />);

    expect(screen.getByText("Idle — no task assigned")).toBeInTheDocument();
    expect(screen.queryByText("Connecting...")).toBeNull();
  });

  it("shows 'Starting...' for running agents that haven't picked up a task yet", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      // taskId intentionally omitted — race between state flip and task bind
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    render(<ActiveAgentsPanel agents={[mockAgent]} />);

    expect(screen.getByText("Starting...")).toBeInTheDocument();
    expect(screen.queryByText("Connecting...")).toBeNull();
  });

  it("renders multiple agent cards with separate transcript streams", async () => {
    mockUseLiveTranscript
      .mockReturnValueOnce({
        entries: [{ type: "text", text: "Agent 1 output", timestamp: "2026-01-01T00:01:00Z" }],
        isConnected: true,
      })
      .mockReturnValueOnce({
        entries: [{ type: "text", text: "Agent 2 output", timestamp: "2026-01-01T00:02:00Z" }],
        isConnected: true,
      });

    const mockAgent1: Agent = {
      id: "agent-001",
      name: "Agent One",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    const mockAgent2: Agent = {
      id: "agent-002",
      name: "Agent Two",
      role: "reviewer",
      state: "running",
      taskId: "FN-002",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    render(<ActiveAgentsPanel agents={[mockAgent1, mockAgent2]} />);

    expect(screen.getByText("Agent 1 output")).toBeInTheDocument();
    expect(screen.getByText("Agent 2 output")).toBeInTheDocument();
  });

  it("renders up to 20 transcript lines per card", async () => {
    // The component receives entries and slices to first 20
    // In real usage, the hook prepends new entries, so most recent first
    // For the mock, we simulate this by providing entries in reverse order
    const manyEntries = Array.from({ length: 25 }, (_, i) => ({
      type: "text" as const,
      text: `Line ${24 - i}`, // Reversed: 24, 23, 22, ..., 1, 0
      timestamp: new Date().toISOString(),
    }));

    mockUseLiveTranscript.mockReturnValue({
      entries: manyEntries,
      isConnected: true,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    render(<ActiveAgentsPanel agents={[mockAgent]} />);

    // Should show the first 20 entries (most recent first)
    // With reversed entries, slice(0, 20) gives us Line 24 through Line 5
    expect(screen.getByText("Line 24")).toBeInTheDocument();
    expect(screen.queryByText("Line 4")).not.toBeInTheDocument(); // Line 4 is beyond index 20
  });

  it("returns null when agents array is empty", async () => {
    const { container } = render(<ActiveAgentsPanel agents={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("displays agent name and task badge", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "My Agent",
      role: "executor",
      state: "running",
      taskId: "FN-042",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    render(<ActiveAgentsPanel agents={[mockAgent]} />);

    expect(screen.getByText("My Agent")).toBeInTheDocument();
    expect(screen.getByText("FN-042")).toBeInTheDocument();
  });

  it("calls onAgentSelect with agent ID when card is clicked", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    const handleSelect = vi.fn();
    render(<ActiveAgentsPanel agents={[mockAgent]} onAgentSelect={handleSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /select agent test agent/i }));

    expect(handleSelect).toHaveBeenCalledWith("agent-001");
  });

  it("shows active indicator when connected", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [{ type: "text", text: "Test", timestamp: "2026-01-01T00:00:00Z" }],
      isConnected: true,
    });

    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    const { container } = render(<ActiveAgentsPanel agents={[mockAgent]} />);

    // The streaming dot should be present when connected
    const streamingDot = container.querySelector(".live-agent-streaming-dot");
    expect(streamingDot).toBeInTheDocument();
  });

  it("passes projectId through to hook for each agent card", async () => {
    mockUseLiveTranscript.mockReturnValue({
      entries: [],
      isConnected: false,
    });

    const mockAgent1: Agent = {
      id: "agent-001",
      name: "Agent One",
      role: "executor",
      state: "running",
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    const mockAgent2: Agent = {
      id: "agent-002",
      name: "Agent Two",
      role: "executor",
      state: "running",
      taskId: "FN-002",
      lastHeartbeatAt: new Date().toISOString(),
    } as Agent;

    render(<ActiveAgentsPanel agents={[mockAgent1, mockAgent2]} projectId="shared-project" />);

    // Both agents should receive the same projectId
    expect(mockUseLiveTranscript).toHaveBeenCalledWith("FN-001", "shared-project");
    expect(mockUseLiveTranscript).toHaveBeenCalledWith("FN-002", "shared-project");
  });
});
