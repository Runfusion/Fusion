import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TerminalModal } from "../TerminalModal";
import * as useTerminalModule from "../../hooks/useTerminal";

// Mock the useTerminal hook
vi.mock("../../hooks/useTerminal", () => ({
  useTerminal: vi.fn(),
}));

const mockUseTerminal = vi.mocked(useTerminalModule.useTerminal);

describe("TerminalModal", () => {
  const mockOnClose = vi.fn();
  const mockExecuteCommand = vi.fn();
  const mockClearHistory = vi.fn();
  const mockKillCurrentCommand = vi.fn();
  const mockSetInputValue = vi.fn();
  const mockNavigateHistoryUp = vi.fn();
  const mockNavigateHistoryDown = vi.fn();
  const mockResetHistoryNavigation = vi.fn();

  const createMockTerminalState = (overrides = {}) => ({
    history: [],
    currentSessionId: null,
    isRunning: false,
    inputValue: "",
    historyIndex: -1,
    error: null,
    executeCommand: mockExecuteCommand,
    clearHistory: mockClearHistory,
    killCurrentCommand: mockKillCurrentCommand,
    setInputValue: mockSetInputValue,
    navigateHistoryUp: mockNavigateHistoryUp,
    navigateHistoryDown: mockNavigateHistoryDown,
    resetHistoryNavigation: mockResetHistoryNavigation,
    ...overrides,
  });

  beforeEach(() => {
    mockOnClose.mockClear();
    mockExecuteCommand.mockClear();
    mockClearHistory.mockClear();
    mockKillCurrentCommand.mockClear();
    mockSetInputValue.mockClear();
    mockNavigateHistoryUp.mockClear();
    mockNavigateHistoryDown.mockClear();
    mockResetHistoryNavigation.mockClear();
    
    mockUseTerminal.mockReturnValue(createMockTerminalState());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders without crashing when open", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    expect(screen.getByTestId("terminal-welcome")).toBeTruthy();
  });

  it("does not render when closed", () => {
    const { container } = render(
      <TerminalModal isOpen={false} onClose={mockOnClose} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows welcome message when empty", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId("terminal-welcome")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Interactive Terminal" })).toBeTruthy();
  });

  it("executes command on form submit", async () => {
    const { rerender } = render(<TerminalModal isOpen={true} onClose={mockOnClose} />);
    
    // Update mock to provide a value
    mockUseTerminal.mockReturnValue(createMockTerminalState({ inputValue: "ls -la" }));
    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const form = screen.getByTestId("terminal-input").closest("form");
    fireEvent.submit(form!);

    expect(mockExecuteCommand).toHaveBeenCalledWith("ls -la");
  });

  it("executes initial command when provided", async () => {
    mockUseTerminal.mockReturnValue(createMockTerminalState({ inputValue: "" }));
    
    render(
      <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="git status" />
    );

    await waitFor(() => {
      expect(mockExecuteCommand).toHaveBeenCalledWith("git status");
    });
  });

  it("clears history when clear button clicked", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    fireEvent.click(screen.getByTestId("terminal-clear-btn"));

    expect(mockClearHistory).toHaveBeenCalled();
  });

  it("kills process when kill button clicked while running", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ isRunning: true, currentSessionId: "session-123" })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    fireEvent.click(screen.getByTestId("terminal-kill-btn"));

    expect(mockKillCurrentCommand).toHaveBeenCalled();
  });

  it("shows running indicator when command is executing", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        isRunning: true,
        currentSessionId: "session-123",
        history: [
          {
            id: "entry-1",
            command: "sleep 10",
            output: "",
            exitCode: null,
            timestamp: new Date(),
            isRunning: true,
          },
        ],
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId("terminal-entry-entry-1")).toBeTruthy();
    expect(screen.getByText("Running...")).toBeTruthy();
  });

  it("displays command history with output", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        history: [
          {
            id: "entry-1",
            command: "echo hello",
            output: "hello\n",
            exitCode: 0,
            timestamp: new Date(),
            isRunning: false,
          },
          {
            id: "entry-2",
            command: "ls",
            output: "file1.txt\nfile2.txt\n",
            exitCode: 0,
            timestamp: new Date(),
            isRunning: false,
          },
        ],
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId("terminal-entry-entry-1")).toBeTruthy();
    expect(screen.getByTestId("terminal-entry-entry-2")).toBeTruthy();
    expect(screen.getByText("echo hello")).toBeTruthy();
    expect(screen.getByText("ls")).toBeTruthy();
  });

  it("disables input while command is running", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ isRunning: true })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const input = screen.getByTestId("terminal-input");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", "Command running...");
  });

  it("handles Ctrl+C to kill running process", () => {
    const { rerender } = render(<TerminalModal isOpen={true} onClose={mockOnClose} />);
    
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ isRunning: true })
    );
    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);
    
    const input = screen.getByTestId("terminal-input");
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    
    expect(mockKillCurrentCommand).toHaveBeenCalled();
  });

  it("handles Ctrl+L to clear history", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const input = screen.getByTestId("terminal-input");
    fireEvent.keyDown(input, { key: "l", ctrlKey: true });

    expect(mockClearHistory).toHaveBeenCalled();
  });

  it("handles Up arrow to navigate history", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const input = screen.getByTestId("terminal-input");
    fireEvent.keyDown(input, { key: "ArrowUp" });

    expect(mockNavigateHistoryUp).toHaveBeenCalled();
  });

  it("handles Down arrow to navigate history", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const input = screen.getByTestId("terminal-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(mockNavigateHistoryDown).toHaveBeenCalled();
  });

  it("modal closes on Escape key press", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("modal closes on overlay click", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const overlay = screen.getByTestId("terminal-modal-overlay");
    fireEvent.click(overlay);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("modal does not close when clicking inside modal content", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const modal = screen.getByTestId("terminal-modal");
    fireEvent.click(modal);

    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("modal closes on close button click", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    fireEvent.click(screen.getByTestId("terminal-close-btn"));

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("updates input value on change", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const input = screen.getByTestId("terminal-input");
    fireEvent.change(input, { target: { value: "git status" } });

    expect(mockSetInputValue).toHaveBeenCalledWith("git status");
  });

  it("marks error output with error class", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        history: [
          {
            id: "entry-1",
            command: "exit 1",
            output: "Error occurred",
            exitCode: 1,
            timestamp: new Date(),
            isRunning: false,
          },
        ],
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const output = screen.getByText("Error occurred");
    expect(output.className).toContain("terminal-output-error");
  });

  it("focuses input when modal opens", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const input = screen.getByTestId("terminal-input");
      expect(document.activeElement).toBe(input);
    });
  });
});
