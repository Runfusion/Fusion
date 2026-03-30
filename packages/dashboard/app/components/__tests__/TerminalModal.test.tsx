import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { TerminalModal } from "../TerminalModal";
import type { Task } from "@kb/core";
import * as useMultiAgentLogsModule from "../../hooks/useMultiAgentLogs";

// Mock the useMultiAgentLogs hook
vi.mock("../../hooks/useMultiAgentLogs", () => ({
  useMultiAgentLogs: vi.fn(),
}));

const mockUseMultiAgentLogs = vi.mocked(useMultiAgentLogsModule.useMultiAgentLogs);

describe("TerminalModal", () => {
  const mockOnClose = vi.fn();

  const createMockTask = (id: string, title?: string): Task => ({
    id,
    title: title || `Task ${id}`,
    description: `Description for ${id}`,
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: undefined,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  beforeEach(() => {
    mockOnClose.mockClear();
    mockUseMultiAgentLogs.mockReturnValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders without crashing when open with empty task list", () => {
    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={[]} />
    );

    expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    expect(screen.getByTestId("terminal-no-tasks").textContent).toContain("No active tasks");
    expect(screen.getByTestId("terminal-empty-state").textContent).toContain("No tasks currently in progress");
  });

  it("renders without crashing when open with multiple in-progress tasks", () => {
    const tasks = [
      createMockTask("KB-001", "First Task"),
      createMockTask("KB-002", "Second Task"),
    ];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [], loading: false, clear: vi.fn() },
      "KB-002": { entries: [], loading: false, clear: vi.fn() },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    expect(screen.getByTestId("terminal-tab-KB-001")).toBeTruthy();
    expect(screen.getByTestId("terminal-tab-KB-002")).toBeTruthy();
  });

  it("does not render when closed", () => {
    const tasks = [createMockTask("KB-001")];

    const { container } = render(
      <TerminalModal isOpen={false} onClose={mockOnClose} tasks={tasks} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("shows appropriate empty state when no in-progress tasks", () => {
    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={[]} />
    );

    expect(screen.getByText("No active tasks")).toBeTruthy();
    expect(screen.getByText("No tasks currently in progress.")).toBeTruthy();
    expect(screen.getByText("Start a task to see live logs here.")).toBeTruthy();
  });

  it("tab switching changes which task's logs are displayed", async () => {
    const tasks = [
      createMockTask("KB-001", "First Task"),
      createMockTask("KB-002", "Second Task"),
    ];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [], loading: false, clear: vi.fn() },
      "KB-002": { entries: [], loading: false, clear: vi.fn() },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    // First task should be active by default
    expect(screen.getByTestId("terminal-active-task-id").textContent).toBe("KB-001");

    // Click on second tab
    fireEvent.click(screen.getByTestId("terminal-tab-KB-002"));

    // Second task should now be active
    await waitFor(() => {
      expect(screen.getByTestId("terminal-active-task-id").textContent).toBe("KB-002");
    });
  });

  it("active tab has correct styling with indicator", () => {
    const tasks = [
      createMockTask("KB-001", "First Task"),
      createMockTask("KB-002", "Second Task"),
    ];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [], loading: false, clear: vi.fn() },
      "KB-002": { entries: [], loading: false, clear: vi.fn() },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    // First tab should be active by default
    const tab1 = screen.getByTestId("terminal-tab-KB-001");
    const tab2 = screen.getByTestId("terminal-tab-KB-002");

    expect(tab1.className).toContain("terminal-tab--active");
    expect(tab2.className).not.toContain("terminal-tab--active");

    // Active tab should have indicator
    expect(screen.getByTestId("terminal-tab-indicator-KB-001")).toBeTruthy();
  });

  it("clicking clear button clears that tab's log entries", () => {
    const mockClear = vi.fn();
    const tasks = [createMockTask("KB-001")];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [{ timestamp: "2026-01-01T00:00:00Z", taskId: "KB-001", text: "log", type: "text" as const }], loading: false, clear: mockClear },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    const clearBtn = screen.getByTestId("terminal-clear-btn");
    fireEvent.click(clearBtn);

    expect(mockClear).toHaveBeenCalled();
  });

  it("modal closes on Escape key press", () => {
    const tasks = [createMockTask("KB-001")];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [], loading: false, clear: vi.fn() },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("modal closes on overlay click", () => {
    const tasks = [createMockTask("KB-001")];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [], loading: false, clear: vi.fn() },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    const overlay = screen.getByTestId("terminal-modal-overlay");
    fireEvent.click(overlay);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("modal does not close when clicking inside modal content", () => {
    const tasks = [createMockTask("KB-001")];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [], loading: false, clear: vi.fn() },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    const modal = screen.getByTestId("terminal-modal");
    fireEvent.click(modal);

    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("modal closes on close button click", () => {
    const tasks = [createMockTask("KB-001")];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [], loading: false, clear: vi.fn() },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    const closeBtn = screen.getByTestId("terminal-close-btn");
    fireEvent.click(closeBtn);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("displays task information in toolbar", () => {
    const tasks = [createMockTask("KB-001", "My Test Task")];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [], loading: false, clear: vi.fn() },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    expect(screen.getByTestId("terminal-active-task-id").textContent).toBe("KB-001");
    expect(screen.getByTestId("terminal-active-task-title").textContent).toBe("My Test Task");
  });

  it("uses description as title fallback when title is not provided", () => {
    const tasks = [{
      ...createMockTask("KB-001"),
      title: undefined,
      description: "My Description",
    }];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [], loading: false, clear: vi.fn() },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    expect(screen.getByTestId("terminal-active-task-title").textContent).toBe("My Description");
  });

  it("passes correct entries to AgentLogViewer", () => {
    const tasks = [createMockTask("KB-001")];
    const entries = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "KB-001", text: "log1", type: "text" as const },
      { timestamp: "2026-01-01T00:01:00Z", taskId: "KB-001", text: "log2", type: "tool" as const },
    ];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries, loading: false, clear: vi.fn() },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    expect(screen.getByTestId("agent-log-viewer")).toBeTruthy();
  });

  it("passes loading state to AgentLogViewer", () => {
    const tasks = [createMockTask("KB-001")];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [], loading: true, clear: vi.fn() },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    expect(screen.getByTestId("agent-log-viewer")).toBeTruthy();
    expect(screen.getByText("Loading agent logs…")).toBeTruthy();
  });

  it("switches to first task when active task is removed from list", () => {
    const tasks = [
      createMockTask("KB-001"),
      createMockTask("KB-002"),
    ];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [], loading: false, clear: vi.fn() },
      "KB-002": { entries: [], loading: false, clear: vi.fn() },
    });

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    // Initially KB-001 should be active
    expect(screen.getByTestId("terminal-active-task-id").textContent).toBe("KB-001");

    // Click KB-002 to make it active
    act(() => {
      screen.getByTestId("terminal-tab-KB-002").click();
    });

    expect(screen.getByTestId("terminal-active-task-id").textContent).toBe("KB-002");

    // Rerender with only KB-001
    rerender(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={[tasks[0]]} />
    );

    // Should switch back to KB-001
    expect(screen.getByTestId("terminal-active-task-id").textContent).toBe("KB-001");
  });

  it("tab labels show task IDs", () => {
    const tasks = [
      createMockTask("KB-001"),
      createMockTask("KB-002"),
    ];

    mockUseMultiAgentLogs.mockReturnValue({
      "KB-001": { entries: [], loading: false, clear: vi.fn() },
      "KB-002": { entries: [], loading: false, clear: vi.fn() },
    });

    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} tasks={tasks} />
    );

    const tab1 = screen.getByTestId("terminal-tab-KB-001");
    const tab2 = screen.getByTestId("terminal-tab-KB-002");

    expect(tab1.textContent).toContain("KB-001");
    expect(tab2.textContent).toContain("KB-002");
  });
});
