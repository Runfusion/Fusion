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
  const mockSetInput = vi.fn();
  const mockKillCurrentCommand = vi.fn();
  const mockNavigateHistory = vi.fn();

  const createMockTerminalState = (overrides = {}) => ({
    history: [],
    input: "",
    isRunning: false,
    currentSessionId: null,
    currentDirectory: "~/project",
    executeCommand: mockExecuteCommand,
    clearHistory: mockClearHistory,
    setInput: mockSetInput,
    killCurrentCommand: mockKillCurrentCommand,
    navigateHistory: mockNavigateHistory,
    ...overrides,
  });

  beforeEach(() => {
    mockOnClose.mockClear();
    mockExecuteCommand.mockClear();
    mockClearHistory.mockClear();
    mockSetInput.mockClear();
    mockKillCurrentCommand.mockClear();
    mockNavigateHistory.mockClear();
    mockUseTerminal.mockReturnValue(createMockTerminalState());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not render when closed", () => {
    const { container } = render(
      <TerminalModal isOpen={false} onClose={mockOnClose} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders when open", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    expect(screen.getByTestId("terminal-content")).toBeTruthy();
    expect(screen.getByTestId("terminal-input")).toBeTruthy();
  });

  it("shows welcome message when history is empty", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId("terminal-welcome")).toBeTruthy();
    expect(screen.getByText("Interactive Terminal")).toBeTruthy();
  });

  it("displays command history", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        history: [
          { command: "ls -la", output: "file1\nfile2", exitCode: 0, isRunning: false, timestamp: new Date() },
        ],
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId("terminal-output")).toBeTruthy();
    expect(screen.getByText("ls -la")).toBeTruthy();
    expect(screen.getByTestId("terminal-output-0").textContent).toContain("file1");
  });

  it("calls onClose when clicking overlay", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    fireEvent.click(screen.getByTestId("terminal-modal-overlay"));

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("calls onClose when clicking close button", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    fireEvent.click(screen.getByTestId("terminal-close-btn"));

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("closes on escape key", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("updates input value on type", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const input = screen.getByTestId("terminal-input");
    fireEvent.change(input, { target: { value: "ls" } });

    expect(mockSetInput).toHaveBeenCalledWith("ls");
  });

  it("executes command on Enter key", async () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        input: "ls -la",
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const input = screen.getByTestId("terminal-input");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockExecuteCommand).toHaveBeenCalledWith("ls -la");
    });
  });

  it("does not execute empty command on Enter", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const input = screen.getByTestId("terminal-input");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it("navigates history on up arrow", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        input: "current",
      })
    );
    mockNavigateHistory.mockReturnValue("previous");

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const input = screen.getByTestId("terminal-input");
    fireEvent.keyDown(input, { key: "ArrowUp" });

    expect(mockNavigateHistory).toHaveBeenCalledWith("up", "current");
    expect(mockSetInput).toHaveBeenCalledWith("previous");
  });

  it("navigates history on down arrow", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        input: "current",
      })
    );
    mockNavigateHistory.mockReturnValue("next");

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const input = screen.getByTestId("terminal-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(mockNavigateHistory).toHaveBeenCalledWith("down", "current");
    expect(mockSetInput).toHaveBeenCalledWith("next");
  });

  it("clears history on Ctrl+L", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const input = screen.getByTestId("terminal-input");
    fireEvent.keyDown(input, { key: "l", ctrlKey: true });

    expect(mockClearHistory).toHaveBeenCalled();
  });

  it("kills running command on Ctrl+C when running", async () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        isRunning: true,
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const input = screen.getByTestId("terminal-input");
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });

    await waitFor(() => {
      expect(mockKillCurrentCommand).toHaveBeenCalled();
    });
  });

  it("shows kill button when command is running", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        isRunning: true,
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId("terminal-kill-btn")).toBeTruthy();
  });

  it("hides kill button when not running", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        isRunning: false,
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.queryByTestId("terminal-kill-btn")).toBeNull();
  });

  it("disables input when command is running", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        isRunning: true,
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId("terminal-input")).toBeDisabled();
  });

  it("shows running indicator for running commands", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        history: [
          { command: "sleep 10", output: "", exitCode: null, isRunning: true, timestamp: new Date() },
        ],
        isRunning: true,
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const entry = screen.getByTestId("terminal-entry-0");
    expect(entry.textContent).toContain("●");
  });

  it("shows exit code for completed commands", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        history: [
          { command: "ls", output: "", exitCode: 0, isRunning: false, timestamp: new Date() },
        ],
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId("terminal-exit-0")).toBeTruthy();
  });

  it("shows error exit code for failed commands", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        history: [
          { command: "false", output: "", exitCode: 1, isRunning: false, timestamp: new Date() },
        ],
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const exitCode = screen.getByTestId("terminal-exit-0");
    expect(exitCode.textContent).toContain("1");
  });

  it("disables clear button when history is empty", () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId("terminal-clear-btn")).toBeDisabled();
  });

  it("shows current directory in status bar", () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        currentDirectory: "/home/user/project",
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByText("/home/user/project")).toBeTruthy();
  });

  it("executes initial command on mount when provided", async () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        history: [],
        isRunning: false,
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm install" />);

    await waitFor(() => {
      expect(mockExecuteCommand).toHaveBeenCalledWith("npm install");
    });
  });
});
