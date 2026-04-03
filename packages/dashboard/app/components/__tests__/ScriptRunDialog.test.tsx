import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ScriptRunDialog } from "../ScriptRunDialog";

// Mock the API
vi.mock("../../api", () => ({
  killPtyTerminalSession: vi.fn(() => Promise.resolve({ killed: true })),
}));

// Track useTerminal callback registrations
const mockCallbacks = {
  data: [] as ((data: string) => void)[],
  scrollback: [] as ((data: string) => void)[],
  exit: [] as ((code: number) => void)[],
  connect: [] as ((info: { shell: string; cwd: string }) => void)[],
};

const defaultUseTerminalReturn = {
  connectionStatus: "connected" as const,
  sendInput: vi.fn(),
  resize: vi.fn(),
  onData: vi.fn((cb: (data: string) => void) => {
    mockCallbacks.data.push(cb);
    return () => {
      mockCallbacks.data = mockCallbacks.data.filter((c) => c !== cb);
    };
  }),
  onExit: vi.fn((cb: (code: number) => void) => {
    mockCallbacks.exit.push(cb);
    return () => {
      mockCallbacks.exit = mockCallbacks.exit.filter((c) => c !== cb);
    };
  }),
  onConnect: vi.fn((cb: (info: { shell: string; cwd: string }) => void) => {
    mockCallbacks.connect.push(cb);
    return () => {
      mockCallbacks.connect = mockCallbacks.connect.filter((c) => c !== cb);
    };
  }),
  onScrollback: vi.fn((cb: (data: string) => void) => {
    mockCallbacks.scrollback.push(cb);
    return () => {
      mockCallbacks.scrollback = mockCallbacks.scrollback.filter((c) => c !== cb);
    };
  }),
  reconnect: vi.fn(),
};

const mockUseTerminal = vi.fn(() => ({ ...defaultUseTerminalReturn }));

vi.mock("../../hooks/useTerminal", () => ({
  useTerminal: (...args: unknown[]) => mockUseTerminal(...args),
}));

const defaultProps = {
  isOpen: true as boolean,
  onClose: vi.fn(),
  scriptName: "build",
  sessionId: "sess-123",
  command: "npm run build",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCallbacks.data = [];
  mockCallbacks.scrollback = [];
  mockCallbacks.exit = [];
  mockCallbacks.connect = [];
  mockUseTerminal.mockClear();
  mockUseTerminal.mockReturnValue({ ...defaultUseTerminalReturn });
});

describe("ScriptRunDialog", () => {
  it("renders with script name and command when open", () => {
    render(<ScriptRunDialog {...defaultProps} />);

    expect(screen.getByTestId("script-run-dialog-overlay")).toBeTruthy();
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByTestId("script-run-command")).toBeTruthy();
    expect(screen.getByText("npm run build")).toBeTruthy();
  });

  it("returns null when not open", () => {
    render(<ScriptRunDialog {...defaultProps} isOpen={false} />);

    expect(screen.queryByTestId("script-run-dialog-overlay")).toBeNull();
  });

  it("shows loading state while waiting for output", () => {
    render(<ScriptRunDialog {...defaultProps} />);

    expect(screen.getByText("Waiting for output...")).toBeTruthy();
  });

  it("renders live output as it arrives", async () => {
    render(<ScriptRunDialog {...defaultProps} />);

    // Simulate data arriving
    await act(async () => {
      mockCallbacks.data.forEach((cb) => cb("Building project...\n"));
    });

    await waitFor(() => {
      expect(screen.getByText(/Building project\.\.\./)).toBeTruthy();
    });

    // Simulate more data
    await act(async () => {
      mockCallbacks.data.forEach((cb) => cb("Done!\n"));
    });

    await waitFor(() => {
      expect(screen.getByText(/Done!/)).toBeTruthy();
    });
  });

  it("shows completed status on exit code 0", async () => {
    render(<ScriptRunDialog {...defaultProps} />);

    await act(async () => {
      mockCallbacks.exit.forEach((cb) => cb(0));
    });

    await waitFor(() => {
      expect(screen.getByText("Completed")).toBeTruthy();
      expect(screen.getByTestId("script-run-exit-code")).toBeTruthy();
      expect(screen.getByText("Exit code: 0")).toBeTruthy();
    });
  });

  it("shows error status on non-zero exit code", async () => {
    render(<ScriptRunDialog {...defaultProps} />);

    await act(async () => {
      mockCallbacks.exit.forEach((cb) => cb(1));
    });

    await waitFor(() => {
      expect(screen.getByText(/Failed \(exit code 1\)/)).toBeTruthy();
      expect(screen.getByText("Exit code: 1")).toBeTruthy();
      const exitCodeEl = screen.getByTestId("script-run-exit-code");
      expect(exitCodeEl.classList.contains("error")).toBe(true);
    });
  });

  it("calls killPtyTerminalSession when closed while running", async () => {
    const onClose = vi.fn();
    const { killPtyTerminalSession } = await import("../../api");

    render(<ScriptRunDialog {...defaultProps} onClose={onClose} />);

    // Click close button while still running
    fireEvent.click(screen.getByTestId("script-run-dialog-close"));

    await waitFor(() => {
      expect(killPtyTerminalSession).toHaveBeenCalledWith("sess-123");
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("does not kill session when closed after completion", async () => {
    const onClose = vi.fn();
    const { killPtyTerminalSession } = await import("../../api");

    render(<ScriptRunDialog {...defaultProps} onClose={onClose} />);

    // Process exits successfully
    await act(async () => {
      mockCallbacks.exit.forEach((cb) => cb(0));
    });

    // Click close after completion
    fireEvent.click(screen.getByTestId("script-run-dialog-close"));

    await waitFor(() => {
      expect(killPtyTerminalSession).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("closes on Escape key", async () => {
    const onClose = vi.fn();

    render(<ScriptRunDialog {...defaultProps} onClose={onClose} />);

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(onClose).toHaveBeenCalled();
  });

  it("closes on overlay click", async () => {
    const onClose = vi.fn();

    render(<ScriptRunDialog {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("script-run-dialog-overlay"));

    expect(onClose).toHaveBeenCalled();
  });

  it("shows connecting status when not yet connected", async () => {
    mockUseTerminal.mockReturnValue({
      ...defaultUseTerminalReturn,
      connectionStatus: "connecting",
    });

    render(<ScriptRunDialog {...defaultProps} />);

    expect(screen.getByText("Connecting...")).toBeTruthy();
  });
});
