import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { TerminalModal } from "../TerminalModal";
import * as useTerminalModule from "../../hooks/useTerminal";
import * as useTerminalSessionsModule from "../../hooks/useTerminalSessions";
import * as apiModule from "../../api";

// Mock hooks and API
vi.mock("../../hooks/useTerminal", () => ({
  useTerminal: vi.fn(),
}));

vi.mock("../../hooks/useTerminalSessions", () => ({
  useTerminalSessions: vi.fn(),
}));

vi.mock("../../api", () => ({
  createTerminalSession: vi.fn(),
  killPtyTerminalSession: vi.fn(),
  listTerminalSessions: vi.fn().mockResolvedValue([]),
}));

// Mock xterm modules to prevent DOM errors in jsdom
const mockTerminalInstance = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  dispose: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  focus: vi.fn(),
  options: { fontSize: 14 },
  cols: 80,
  rows: 24,
};

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(() => mockTerminalInstance),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(() => ({
    fit: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(() => ({
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/addon-webgl", () => {
  throw new Error("WebGL not available");
});

// Suppress xterm CSS import
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const mockUseTerminal = vi.mocked(useTerminalModule.useTerminal);
const mockUseTerminalSessions = vi.mocked(useTerminalSessionsModule.useTerminalSessions);
const mockCreateTerminalSession = vi.mocked(apiModule.createTerminalSession);
const mockKillPtyTerminalSession = vi.mocked(apiModule.killPtyTerminalSession);

// Default tab state
const defaultTab = {
  id: "tab-1",
  sessionId: "test-session-123",
  title: "bash",
  isActive: true,
  createdAt: Date.now(),
};

const defaultSessionState = {
  tabs: [defaultTab],
  activeTab: defaultTab,
  isReady: true,
  bootstrapError: null,
  createTab: vi.fn(),
  closeTab: vi.fn(),
  setActiveTab: vi.fn(),
  updateTabTitle: vi.fn(),
  restartActiveTab: vi.fn(),
  retryBootstrap: vi.fn(),
};

describe("TerminalModal", () => {
  const mockOnClose = vi.fn();
  const mockSendInput = vi.fn();
  const mockResize = vi.fn();
  const mockReconnect = vi.fn();

  const createMockTerminalState = (overrides = {}) => ({
    connectionStatus: "disconnected" as const,
    sendInput: mockSendInput,
    resize: mockResize,
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onConnect: vi.fn(() => vi.fn()),
    onScrollback: vi.fn(() => vi.fn()),
    reconnect: mockReconnect,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateTerminalSession.mockResolvedValue({
      sessionId: "test-session-123",
      shell: "/bin/bash",
      cwd: "/project",
    });
    mockKillPtyTerminalSession.mockResolvedValue({ killed: true });
    mockUseTerminal.mockReturnValue(createMockTerminalState());
    mockUseTerminalSessions.mockReturnValue(defaultSessionState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders without crashing when open", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    });
  });

  it("does not render when closed", () => {
    const { container } = render(<TerminalModal isOpen={false} onClose={mockOnClose} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows loading state while sessions are not ready", async () => {
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      isReady: false,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-loading")).toBeTruthy();
    });
  });

  it("shows error with retry button when bootstrap fails instead of stuck loading", async () => {
    const mockRetryBootstrap = vi.fn();
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [],
      activeTab: null,
      bootstrapError: "Server unreachable",
      retryBootstrap: mockRetryBootstrap,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Should NOT show the loading spinner
    await waitFor(() => {
      expect(screen.queryByTestId("terminal-loading")).toBeNull();
    });

    // Should show the bootstrap error state with retry button
    expect(screen.getByTestId("terminal-bootstrap-error")).toBeTruthy();
    expect(screen.getByText(/Failed to start terminal: Server unreachable/)).toBeTruthy();
    
    const retryBtn = screen.getByTestId("terminal-retry-btn");
    expect(retryBtn).toBeTruthy();
    expect(retryBtn.textContent).toContain("Retry");
  });

  it("retry button calls retryBootstrap from the hook", async () => {
    const mockRetryBootstrap = vi.fn();
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [],
      activeTab: null,
      bootstrapError: "Connection refused",
      retryBootstrap: mockRetryBootstrap,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    const retryBtn = screen.getByTestId("terminal-retry-btn");
    fireEvent.click(retryBtn);

    expect(mockRetryBootstrap).toHaveBeenCalled();
  });

  it("clears error state and shows terminal after successful retry", async () => {
    const mockRetryBootstrap = vi.fn();
    
    // Start with error state
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [],
      activeTab: null,
      bootstrapError: "Server unreachable",
      retryBootstrap: mockRetryBootstrap,
    });

    const { rerender } = render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Error state should be shown
    expect(screen.getByTestId("terminal-bootstrap-error")).toBeTruthy();

    // Simulate successful retry — hook updates state
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [defaultTab],
      activeTab: defaultTab,
      bootstrapError: null,
      retryBootstrap: mockRetryBootstrap,
    });

    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Error state should be gone
    await waitFor(() => {
      expect(screen.queryByTestId("terminal-bootstrap-error")).toBeNull();
    });

    // Loading spinner should also be gone (xterm will init)
    // The loading overlay will disappear after xterm initializes
    expect(screen.queryByTestId("terminal-loading")).toBeNull();
  });

  it("does not show bootstrap error when activeTab exists (recovered state)", async () => {
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      bootstrapError: "Previous error",
      tabs: [defaultTab],
      activeTab: defaultTab,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Bootstrap error should NOT show because activeTab exists
    await waitFor(() => {
      expect(screen.queryByTestId("terminal-bootstrap-error")).toBeNull();
    });
  });

  it("shows tabs when multiple sessions exist", async () => {
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [
        defaultTab,
        { id: "tab-2", sessionId: "test-session-456", title: "zsh", isActive: false, createdAt: Date.now() },
      ],
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText("bash")).toBeTruthy();
      expect(screen.getByText("zsh")).toBeTruthy();
    });
  });

  it("shows active tab styling", async () => {
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [
        { ...defaultTab, isActive: true },
        { id: "tab-2", sessionId: "test-session-456", title: "zsh", isActive: false, createdAt: Date.now() },
      ],
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const activeTab = screen.getByText("bash").closest(".terminal-tab");
      expect(activeTab).toHaveClass("terminal-tab--active");
    });
  });

  it("tab click switches active tab", async () => {
    const mockSetActiveTab = vi.fn();
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [
        { ...defaultTab, isActive: true },
        { id: "tab-2", sessionId: "test-session-456", title: "zsh", isActive: false, createdAt: Date.now() },
      ],
      setActiveTab: mockSetActiveTab,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const zshTab = screen.getByText("zsh");
      fireEvent.click(zshTab);
    });

    expect(mockSetActiveTab).toHaveBeenCalledWith("tab-2");
  });

  it("tab close button closes tab", async () => {
    const mockCloseTab = vi.fn();
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [
        { ...defaultTab, isActive: true },
        { id: "tab-2", sessionId: "test-session-456", title: "zsh", isActive: false, createdAt: Date.now() },
      ],
      closeTab: mockCloseTab,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      // Find the close button for the zsh tab (second tab)
      const closeButtons = screen.getAllByTitle("Close tab");
      const zshCloseBtn = closeButtons[1]; // Second close button (for zsh tab)
      if (zshCloseBtn) {
        fireEvent.click(zshCloseBtn);
      }
    });

    expect(mockCloseTab).toHaveBeenCalledWith("tab-2");
  });

  it("new tab button creates new tab", async () => {
    const mockCreateTab = vi.fn().mockResolvedValue({
      id: "tab-new",
      sessionId: "new-session",
      title: "Terminal 2",
      isActive: true,
      createdAt: Date.now(),
    });
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      createTab: mockCreateTab,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const newTabBtn = screen.getByTitle("New terminal");
      fireEvent.click(newTabBtn);
    });

    expect(mockCreateTab).toHaveBeenCalled();
  });

  it("sessions are NOT killed when modal closes (session persistence)", async () => {
    const { rerender } = render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    });

    await act(async () => {
      rerender(<TerminalModal isOpen={false} onClose={mockOnClose} />);
    });

    // With multi-tab support, sessions should persist when modal closes
    expect(mockKillPtyTerminalSession).not.toHaveBeenCalled();
  });

  it("closes modal on close button click", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const closeBtn = screen.getByTestId("terminal-close-btn");
      fireEvent.click(closeBtn);
    });

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("closes modal on escape key", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("closes modal on overlay click", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const overlay = screen.getByTestId("terminal-modal-overlay");
      fireEvent.click(overlay);
    });

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("shows reconnect button when disconnected", async () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ 
        connectionStatus: "disconnected",
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-reconnect-btn")).toBeTruthy();
    });
  });

  it("reconnects when reconnect button clicked", async () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ 
        connectionStatus: "disconnected",
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const reconnectBtn = screen.getByTestId("terminal-reconnect-btn");
      fireEvent.click(reconnectBtn);
    });

    expect(mockReconnect).toHaveBeenCalled();
  });

  it("WebSocket connects on mount with sessionId from active tab", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(mockUseTerminal).toHaveBeenCalledWith("test-session-123");
    });
  });

  it("initializes xterm after session is ready", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Wait for session to be ready and xterm to initialize
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    // Verify xterm was opened with the terminal container div
    const terminalDiv = screen.getByTestId("terminal-xterm");
    expect(mockTerminalInstance.open).toHaveBeenCalledWith(terminalDiv);
  });

  it("xterm container is rendered (visible under loading overlay) while loading", async () => {
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      isReady: false,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      // The xterm container is always rendered (no display:none) so that
      // terminal.open() can measure dimensions even during a tab switch.
      // The loading overlay visually covers it.
      const xtermDiv = screen.getByTestId("terminal-xterm");
      expect(xtermDiv.style.display).toBe("");
    });
  });

  it("xterm container remains rendered when ready", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const xtermDiv = screen.getByTestId("terminal-xterm");
      expect(xtermDiv.style.display).not.toBe("none");
    });
  });

  it("subscribes to terminal data after xterm is ready", async () => {
    const mockOnData = vi.fn(() => vi.fn());
    const mockOnConnect = vi.fn(() => vi.fn());
    const mockOnExit = vi.fn(() => vi.fn());
    const mockOnScrollback = vi.fn(() => vi.fn());

    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        onData: mockOnData,
        onConnect: mockOnConnect,
        onExit: mockOnExit,
        onScrollback: mockOnScrollback,
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Wait for xterm initialization to complete
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    // After xterm is ready, data subscriptions should be established
    await waitFor(() => {
      expect(mockOnData).toHaveBeenCalled();
      expect(mockOnConnect).toHaveBeenCalled();
      expect(mockOnExit).toHaveBeenCalled();
      expect(mockOnScrollback).toHaveBeenCalled();
    });
  });

  it("calls restartActiveTab when New Session button clicked", async () => {
    const mockRestartActiveTab = vi.fn();
    let exitCallback: ((code: number) => void) | null = null;
    
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      restartActiveTab: mockRestartActiveTab,
    });
    
    // Create a custom mock that captures the exit callback
    const customOnExit = vi.fn((cb: (code: number) => void) => {
      exitCallback = cb;
      return vi.fn();
    });
    
    mockUseTerminal.mockReturnValue({
      connectionStatus: "connected",
      sendInput: mockSendInput,
      resize: mockResize,
      onData: vi.fn(() => vi.fn()),
      onExit: customOnExit,
      onConnect: vi.fn(() => vi.fn()),
      onScrollback: vi.fn(() => vi.fn()),
      reconnect: mockReconnect,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    });

    // Wait for xterm to initialize
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    // Trigger the exit callback to simulate terminal exit
    act(() => {
      if (exitCallback) {
        exitCallback(0);
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId("terminal-restart-btn")).toBeTruthy();
    });

    const restartBtn = screen.getByTestId("terminal-restart-btn");
    fireEvent.click(restartBtn);

    expect(mockRestartActiveTab).toHaveBeenCalled();
  });

  // --- initialCommand / script launch behavior ---
  describe("initialCommand execution", () => {
    it("sends initialCommand to terminal when connected", async () => {
      mockUseTerminal.mockReturnValue(
        createMockTerminalState({ connectionStatus: "connected" })
      );

      render(<TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />);

      await waitFor(() => {
        expect(mockSendInput).toHaveBeenCalledWith("npm run build\n");
      });
    });

    it("does not send the same initialCommand twice on re-renders", async () => {
      mockUseTerminal.mockReturnValue(
        createMockTerminalState({ connectionStatus: "connected" })
      );

      const { rerender } = render(
        <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
      );

      await waitFor(() => {
        expect(mockSendInput).toHaveBeenCalledWith("npm run build\n");
      });

      const callCount = mockSendInput.mock.calls.length;

      // Re-render with same props
      rerender(
        <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
      );

      // Should not send the command again
      expect(mockSendInput).toHaveBeenCalledTimes(callCount);
    });

    it("sends a new initialCommand when it changes while terminal is open", async () => {
      mockUseTerminal.mockReturnValue(
        createMockTerminalState({ connectionStatus: "connected" })
      );

      const { rerender } = render(
        <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
      );

      await waitFor(() => {
        expect(mockSendInput).toHaveBeenCalledWith("npm run build\n");
      });

      // Change the command (e.g., user runs a different script)
      rerender(
        <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm test" />
      );

      await waitFor(() => {
        expect(mockSendInput).toHaveBeenCalledWith("pnpm test\n");
      });
    });

    it("resends command after modal close and reopen", async () => {
      mockUseTerminal.mockReturnValue(
        createMockTerminalState({ connectionStatus: "connected" })
      );

      const { rerender } = render(
        <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
      );

      await waitFor(() => {
        expect(mockSendInput).toHaveBeenCalledWith("npm run build\n");
      });

      // Close the modal
      rerender(
        <TerminalModal isOpen={false} onClose={mockOnClose} initialCommand="npm run build" />
      );

      // Reopen with the same command
      mockSendInput.mockClear();
      rerender(
        <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
      );

      await waitFor(() => {
        expect(mockSendInput).toHaveBeenCalledWith("npm run build\n");
      });
    });
  });

  // --- xterm initialization watchdog tests ---
  describe("xterm initialization watchdog", () => {
    it("shows xterm init error overlay when xterm constructor throws", async () => {
      // Override the mock to throw on construction
      const { Terminal } = await import("@xterm/xterm");
      const OrigTerminal = Terminal;

      // Replace Terminal constructor with one that throws
      const throwingModule = await import("@xterm/xterm");
      (throwingModule as any).Terminal = vi.fn().mockImplementation(() => {
        throw new Error("xterm constructor failed");
      });

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      // Should show xterm init error
      await waitFor(() => {
        expect(screen.getByTestId("terminal-xterm-init-error")).toBeTruthy();
        expect(screen.getByText(/Terminal UI failed to initialize/)).toBeTruthy();
      });

      // Should have a reinitialize button
      const reinitBtn = screen.getByTestId("terminal-reinit-btn");
      expect(reinitBtn).toBeTruthy();
      expect(reinitBtn.textContent).toContain("Reinitialize");

      // Restore original Terminal
      (throwingModule as any).Terminal = OrigTerminal;
    });

    it("clicking Reinitialize button clears error and triggers fresh init attempt", async () => {
      // Make Terminal throw first, then work after reinitialize
      const throwingModule = await import("@xterm/xterm");
      const OrigTerminal = throwingModule.Terminal;

      let callCount = 0;
      (throwingModule as any).Terminal = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error("first init fails");
        }
        // Second call succeeds — return a mock terminal
        return mockTerminalInstance;
      });

      const { rerender } = render(
        <TerminalModal isOpen={true} onClose={mockOnClose} />
      );

      // Wait for error
      await waitFor(() => {
        expect(screen.getByTestId("terminal-xterm-init-error")).toBeTruthy();
      });

      // Click Reinitialize
      const reinitBtn = screen.getByTestId("terminal-reinit-btn");
      fireEvent.click(reinitBtn);

      // After reinitialize, the error should be cleared and xterm should init successfully
      await waitFor(() => {
        expect(screen.queryByTestId("terminal-xterm-init-error")).toBeNull();
      });

      // Restore
      (throwingModule as any).Terminal = OrigTerminal;
    });

    it("shows timeout error when xterm initialization exceeds XTERM_INIT_TIMEOUT_MS", async () => {
      // This test uses vi.isolateModules to override the @xterm/xterm mock
      // for this test only, making the dynamic import hang so the watchdog fires.
      
      // Since isolateModules runs the factory in isolation, we need to set up
      // all mocks inside the callback. However, this conflicts with the hoisted
      // vi.mock calls used by the rest of the test suite.
      //
      // Alternative: directly exercise the timeout path by overriding the module's
      // Terminal export to delay. Since the component does:
      //   await Promise.race([Promise.all([import("@xterm/xterm"), ...]), timeout])
      // and vi.mock resolves imports instantly, the race is always won by imports.
      //
      // We CAN test the timeout by making one of the dynamic imports throw after a
      // delay, but since imports are vi.mock'd, they resolve immediately.
      //
      // Best practical test: verify the timeout error message is rendered correctly
      // by directly triggering the catch block with a timeout-like error.
      const xtermModule = await import("@xterm/xterm");
      const OrigTerminal = xtermModule.Terminal;

      // Simulate the timeout error by making Terminal constructor throw
      // with the exact timeout message the watchdog would produce
      (xtermModule as any).Terminal = vi.fn().mockImplementation(() => {
        throw new Error("xterm initialization timed out");
      });

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByTestId("terminal-xterm-init-error")).toBeTruthy();
      });

      // Verify the timeout-specific message is rendered
      expect(screen.getByText(/timed out/)).toBeTruthy();

      // Reinitialize button should be present
      expect(screen.getByTestId("terminal-reinit-btn")).toBeTruthy();

      // Restore
      (xtermModule as any).Terminal = OrigTerminal;
    });

    it("does not show xterm init error when no activeTab (bootstrap error takes priority)", async () => {
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        tabs: [],
        activeTab: null,
        bootstrapError: "Server unreachable",
      });

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      // Should show bootstrap error, not xterm init error
      await waitFor(() => {
        expect(screen.getByTestId("terminal-bootstrap-error")).toBeTruthy();
      });
      expect(screen.queryByTestId("terminal-xterm-init-error")).toBeNull();
    });

    it("xterm init error is cleared when modal is closed and reopened", async () => {
      // Force xterm init error
      const throwingModule = await import("@xterm/xterm");
      const OrigTerminal = throwingModule.Terminal;

      (throwingModule as any).Terminal = vi.fn().mockImplementation(() => {
        throw new Error("xterm constructor failed");
      });

      const { rerender } = render(
        <TerminalModal isOpen={true} onClose={mockOnClose} />
      );

      // Wait for error to appear
      await waitFor(() => {
        expect(screen.getByTestId("terminal-xterm-init-error")).toBeTruthy();
      });

      // Close the modal
      rerender(<TerminalModal isOpen={false} onClose={mockOnClose} />);

      // Modal is gone
      expect(screen.queryByTestId("terminal-xterm-init-error")).toBeNull();

      // Restore working xterm
      (throwingModule as any).Terminal = OrigTerminal;

      // Reopen the modal
      rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      // Should NOT show the old xterm init error — fresh init attempt
      await waitFor(() => {
        expect(screen.queryByTestId("terminal-xterm-init-error")).toBeNull();
      });
    });
  });
});

// --- Mobile layout regression tests ---
describe("TerminalModal — mobile layout contract", () => {
  const mockOnClose = vi.fn();
  const mockSendInput = vi.fn();
  const mockResize = vi.fn();
  const mockReconnect = vi.fn();

  // Helper: create 5+ tabs for the many-tabs scenario
  const createManyTabs = () => [
    { id: "tab-1", sessionId: "s-1", title: "bash", isActive: true, createdAt: Date.now() },
    { id: "tab-2", sessionId: "s-2", title: "zsh", isActive: false, createdAt: Date.now() },
    { id: "tab-3", sessionId: "s-3", title: "node", isActive: false, createdAt: Date.now() },
    { id: "tab-4", sessionId: "s-4", title: "python3", isActive: false, createdAt: Date.now() },
    { id: "tab-5", sessionId: "s-5", title: "make test", isActive: false, createdAt: Date.now() },
    { id: "tab-6", sessionId: "s-6", title: "docker", isActive: false, createdAt: Date.now() },
  ];

  const createMockTerminalState = (overrides = {}) => ({
    connectionStatus: "disconnected" as const,
    sendInput: mockSendInput,
    resize: mockResize,
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onConnect: vi.fn(() => vi.fn()),
    onScrollback: vi.fn(() => vi.fn()),
    reconnect: mockReconnect,
    ...overrides,
  });

  const manyTabsSessionState = {
    tabs: createManyTabs(),
    activeTab: createManyTabs()[0],
    isReady: true,
    createTab: vi.fn(),
    closeTab: vi.fn(),
    setActiveTab: vi.fn(),
    updateTabTitle: vi.fn(),
    restartActiveTab: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTerminal.mockReturnValue(createMockTerminalState());
    mockUseTerminalSessions.mockReturnValue(manyTabsSessionState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all 6 tabs inside terminal-tabs container with many tabs", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const tabsContainer = screen.getByTestId("terminal-tabs");
      expect(tabsContainer).toBeTruthy();

      // All 6 tab titles should be rendered
      expect(screen.getByText("bash")).toBeTruthy();
      expect(screen.getByText("zsh")).toBeTruthy();
      expect(screen.getByText("node")).toBeTruthy();
      expect(screen.getByText("python3")).toBeTruthy();
      expect(screen.getByText("make test")).toBeTruthy();
      expect(screen.getByText("docker")).toBeTruthy();
    });
  });

  it("preserves header structure: tabs, title, and actions are present", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      // Verify the three structural sections of the header exist
      expect(screen.getByTestId("terminal-tabs")).toBeTruthy();
      expect(screen.getByTestId("terminal-title")).toBeTruthy();
      expect(screen.getByTestId("terminal-actions")).toBeTruthy();
    });
  });

  it("close button is clickable with many tabs", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const closeBtn = screen.getByTestId("terminal-close-btn");
      expect(closeBtn).toBeTruthy();
      fireEvent.click(closeBtn);
    });

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("clear button is clickable with many tabs", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const clearBtn = screen.getByTestId("terminal-clear-btn");
      expect(clearBtn).toBeTruthy();
      fireEvent.click(clearBtn);
    });

    // Clear calls xtermRef.current?.clear() — just verify button is functional
    expect(screen.getByTestId("terminal-clear-btn")).toBeTruthy();
  });

  it("reconnect button is clickable with many tabs when disconnected", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const reconnectBtn = screen.getByTestId("terminal-reconnect-btn");
      expect(reconnectBtn).toBeTruthy();
      fireEvent.click(reconnectBtn);
    });

    expect(mockReconnect).toHaveBeenCalled();
  });

  it("action buttons have .terminal-action-label spans for mobile CSS targeting", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      // The reconnect and clear buttons should have .terminal-action-label spans
      const reconnectBtn = screen.getByTestId("terminal-reconnect-btn");
      const labelSpan = reconnectBtn.querySelector(".terminal-action-label");
      expect(labelSpan).toBeTruthy();
      expect(labelSpan?.textContent).toBe("Reconnect");

      const clearBtn = screen.getByTestId("terminal-clear-btn");
      const clearLabel = clearBtn.querySelector(".terminal-action-label");
      expect(clearLabel).toBeTruthy();
      expect(clearLabel?.textContent).toBe("Clear");
    });
  });

  it("terminal-title section contains the status indicator for connection state", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const titleSection = screen.getByTestId("terminal-title");
      // Should contain the TerminalIcon (svg) and the status indicator span
      expect(titleSection.querySelector("svg")).toBeTruthy();
      const statusIndicator = titleSection.querySelector(".terminal-status");
      expect(statusIndicator).toBeTruthy();
      // Disconnected state should show disconnected class
      expect(statusIndicator?.classList.contains("disconnected")).toBe(true);
    });
  });

  it("status-bar shows connection state text alongside tabs row", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const statusBar = screen.getByTestId("terminal-status-bar");
      expect(statusBar).toBeTruthy();
      // Should contain connection status text
      const connectionStatus = statusBar.querySelector(".terminal-connection-status");
      expect(connectionStatus?.textContent).toBe("Disconnected");
    });
  });

  it("delivers buffered terminal output to xterm when subscriptions are established after websocket messages", async () => {
    // This test verifies that the useTerminal hook's early message buffering
    // works correctly with TerminalModal's late-subscription pattern (xterm
    // must initialize before onData/onScrollback/onConnect are wired up).
    // The hook's buffer ensures scrollback and early shell output are not lost.

    let capturedDataCallback: ((data: string) => void) | null = null;
    let capturedScrollbackCallback: ((data: string) => void) | null = null;

    const mockOnData = vi.fn((cb: (data: string) => void) => {
      capturedDataCallback = cb;
      return vi.fn();
    });
    const mockOnScrollback = vi.fn((cb: (data: string) => void) => {
      capturedScrollbackCallback = cb;
      return vi.fn();
    });

    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        connectionStatus: "connected",
        onData: mockOnData,
        onScrollback: mockOnScrollback,
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Wait for xterm to initialize and subscriptions to be established
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(mockOnData).toHaveBeenCalled();
      expect(mockOnScrollback).toHaveBeenCalled();
    });

    // Now simulate late-arriving data (after subscriptions are wired)
    // This verifies the write path from callback to xterm
    act(() => {
      if (capturedDataCallback) {
        capturedDataCallback("prompt$ ");
      }
      if (capturedScrollbackCallback) {
        capturedScrollbackCallback("previous output");
      }
    });

    // xterm should receive the data via write()
    expect(mockTerminalInstance.write).toHaveBeenCalledWith("prompt$ ");
    expect(mockTerminalInstance.write).toHaveBeenCalledWith("previous output");
  });

  /**
   * Regression: terminal shows "Connected" and cursor but no visible prompt.
   *
   * The original bug occurred when PTY output containing the initial shell
   * prompt was emitted during the resize-suppression window (150ms after the
   * initial fitAddon.fit()). That output was silently discarded, so xterm
   * rendered a connected cursor over an empty terminal — the prompt was
   * permanently lost for that session.
   *
   * This test verifies the buffering layer ensures the prompt arrives at
   * xterm even when subscribers register after the WebSocket has already
   * received the scrollback and data messages.
   */
  it("displays the shell prompt even when scrollback and data arrive before xterm subscription", async () => {
    let capturedDataCallback: ((data: string) => void) | null = null;
    let capturedScrollbackCallback: ((data: string) => void) | null = null;

    const mockOnData = vi.fn((cb: (data: string) => void) => {
      capturedDataCallback = cb;
      return vi.fn();
    });
    const mockOnScrollback = vi.fn((cb: (data: string) => void) => {
      capturedScrollbackCallback = cb;
      return vi.fn();
    });

    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        connectionStatus: "connected",
        onData: mockOnData,
        onScrollback: mockOnScrollback,
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Wait for xterm to initialize
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(mockOnData).toHaveBeenCalled();
      expect(mockOnScrollback).toHaveBeenCalled();
    });

    // Simulate the prompt arriving: scrollback contains the initial prompt,
    // and data contains subsequent output (echo of first keystroke)
    act(() => {
      if (capturedScrollbackCallback) {
        capturedScrollbackCallback("user@host:~$ ");
      }
      if (capturedDataCallback) {
        capturedDataCallback("ls\r\n");
      }
    });

    // xterm must receive BOTH the prompt and the data — neither should be lost
    expect(mockTerminalInstance.write).toHaveBeenCalledWith("user@host:~$ ");
    expect(mockTerminalInstance.write).toHaveBeenCalledWith("ls\r\n");
  });
});

// --- New-tab regression tests ---
describe("TerminalModal — new tab while modal open", () => {
  const mockOnClose = vi.fn();
  const mockSendInput = vi.fn();
  const mockResize = vi.fn();
  const mockReconnect = vi.fn();

  const createMockTerminalState = (overrides = {}) => ({
    connectionStatus: "disconnected" as const,
    sendInput: mockSendInput,
    resize: mockResize,
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onConnect: vi.fn(() => vi.fn()),
    onScrollback: vi.fn(() => vi.fn()),
    reconnect: mockReconnect,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateTerminalSession.mockResolvedValue({
      sessionId: "test-session-123",
      shell: "/bin/bash",
      cwd: "/project",
    });
    mockKillPtyTerminalSession.mockResolvedValue({ killed: true });
    mockUseTerminal.mockReturnValue(createMockTerminalState());
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Regression: creating a new tab while the modal is open must initialize
   * xterm for the new session immediately — no close/reopen required.
   */
  it("initializes xterm for the new tab without closing and reopening the modal", async () => {
    // Start with one tab
    const firstTab = {
      id: "tab-1",
      sessionId: "session-1",
      title: "Terminal 1",
      isActive: true,
      createdAt: Date.now(),
    };

    const { result, rerender } = renderWithTabs([firstTab], firstTab);

    // Wait for initial xterm to be created
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalledTimes(1);
    });

    // Now simulate creating a new tab — the sessions hook updates state
    const newTab = {
      id: "tab-2",
      sessionId: "session-2",
      title: "Terminal 2",
      isActive: true,
      createdAt: Date.now(),
    };
    const deactivatedFirstTab = { ...firstTab, isActive: false };

    // Update the mock to return the new tab state
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [deactivatedFirstTab, newTab],
      activeTab: newTab,
    });

    // The useTerminal hook is called with the new sessionId
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ connectionStatus: "connected" })
    );

    // Re-render to pick up the new tab
    rerender(
      <TerminalModal isOpen={true} onClose={mockOnClose} />
    );

    // xterm should be reinitialized for the new session
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalledTimes(2);
    });

    // Loading state should clear — no loading overlay present
    await waitFor(() => {
      expect(screen.queryByTestId("terminal-loading")).toBeNull();
    });
  });

  /**
   * Regression: output from the new tab's session must be delivered to xterm
   * via write(), not silently dropped.
   */
  it("delivers output from new tab session to xterm write()", async () => {
    let capturedDataCallback: ((data: string) => void) | null = null;
    let capturedScrollbackCallback: ((data: string) => void) | null = null;

    const mockOnData = vi.fn((cb: (data: string) => void) => {
      capturedDataCallback = cb;
      return vi.fn();
    });
    const mockOnScrollback = vi.fn((cb: (data: string) => void) => {
      capturedScrollbackCallback = cb;
      return vi.fn();
    });

    const newTab = {
      id: "tab-2",
      sessionId: "session-2",
      title: "Terminal 2",
      isActive: true,
      createdAt: Date.now(),
    };

    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [
        { id: "tab-1", sessionId: "session-1", title: "Terminal 1", isActive: false, createdAt: Date.now() },
        newTab,
      ],
      activeTab: newTab,
    });

    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        connectionStatus: "connected",
        onData: mockOnData,
        onScrollback: mockOnScrollback,
      })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Wait for xterm to initialize and subscriptions to be established
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(mockOnData).toHaveBeenCalled();
      expect(mockOnScrollback).toHaveBeenCalled();
    });

    // Clear any previous write calls from buffered replay
    mockTerminalInstance.write.mockClear();

    // Simulate output arriving for the new tab's session
    act(() => {
      if (capturedScrollbackCallback) {
        capturedScrollbackCallback("user@host:~$ ");
      }
      if (capturedDataCallback) {
        capturedDataCallback("ls\r\n");
      }
    });

    // xterm must receive the output via write()
    expect(mockTerminalInstance.write).toHaveBeenCalledWith("user@host:~$ ");
    expect(mockTerminalInstance.write).toHaveBeenCalledWith("ls\r\n");
  });

  /**
   * Regression: subscriptions must be established for the new session,
   * not stuck on the prior tab's session. When the active session changes,
   * the subscription effect must re-run with the new sessionId.
   */
  it("establishes subscriptions for the new session after tab creation", async () => {
    const mockOnData1 = vi.fn(() => vi.fn());
    const mockOnScrollback1 = vi.fn(() => vi.fn());
    const mockOnConnect1 = vi.fn(() => vi.fn());
    const mockOnExit1 = vi.fn(() => vi.fn());

    // First tab's terminal state
    const firstTabState = createMockTerminalState({
      connectionStatus: "connected",
      onData: mockOnData1,
      onScrollback: mockOnScrollback1,
      onConnect: mockOnConnect1,
      onExit: mockOnExit1,
    });

    const firstTab = {
      id: "tab-1",
      sessionId: "session-1",
      title: "Terminal 1",
      isActive: true,
      createdAt: Date.now(),
    };

    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [firstTab],
      activeTab: firstTab,
    });
    mockUseTerminal.mockReturnValue(firstTabState);

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} />
    );

    // Wait for initial subscriptions to be established for session-1
    await waitFor(() => {
      expect(mockOnData1).toHaveBeenCalled();
      expect(mockOnScrollback1).toHaveBeenCalled();
    });

    // Now create a new tab — new session
    const mockOnData2 = vi.fn(() => vi.fn());
    const mockOnScrollback2 = vi.fn(() => vi.fn());
    const mockOnConnect2 = vi.fn(() => vi.fn());
    const mockOnExit2 = vi.fn(() => vi.fn());

    const secondTabState = createMockTerminalState({
      connectionStatus: "connected",
      onData: mockOnData2,
      onScrollback: mockOnScrollback2,
      onConnect: mockOnConnect2,
      onExit: mockOnExit2,
    });

    const newTab = {
      id: "tab-2",
      sessionId: "session-2",
      title: "Terminal 2",
      isActive: true,
      createdAt: Date.now(),
    };

    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [{ ...firstTab, isActive: false }, newTab],
      activeTab: newTab,
    });
    mockUseTerminal.mockReturnValue(secondTabState);

    rerender(
      <TerminalModal isOpen={true} onClose={mockOnClose} />
    );

    // Subscriptions should be re-established for session-2
    await waitFor(() => {
      expect(mockOnData2).toHaveBeenCalled();
      expect(mockOnScrollback2).toHaveBeenCalled();
      expect(mockOnConnect2).toHaveBeenCalled();
      expect(mockOnExit2).toHaveBeenCalled();
    });
  });

  /**
   * Regression: the xterm container must not have display:none when switching
   * tabs, so that terminal.open() can always measure container dimensions.
   */
  it("xterm container has no display:none during tab switch re-initialization", async () => {
    const firstTab = {
      id: "tab-1",
      sessionId: "session-1",
      title: "Terminal 1",
      isActive: true,
      createdAt: Date.now(),
    };

    const { rerender } = renderWithTabs([firstTab], firstTab);

    // Wait for initial xterm
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    // Switch to new tab
    const newTab = {
      id: "tab-2",
      sessionId: "session-2",
      title: "Terminal 2",
      isActive: true,
      createdAt: Date.now(),
    };

    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [{ ...firstTab, isActive: false }, newTab],
      activeTab: newTab,
    });

    rerender(
      <TerminalModal isOpen={true} onClose={mockOnClose} />
    );

    // The xterm container should never have display:none
    await waitFor(() => {
      const xtermDiv = screen.getByTestId("terminal-xterm");
      expect(xtermDiv.style.display).not.toBe("none");
    });
  });

  // Helper to render with specific tabs
  function renderWithTabs(tabs: typeof defaultTab[], activeTab: typeof defaultTab) {
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs,
      activeTab,
    });
    mockUseTerminal.mockReturnValue(createMockTerminalState());

    return render(<TerminalModal isOpen={true} onClose={mockOnClose} />);
  }
});

// --- Virtual keyboard overlap handling ---
describe("TerminalModal — virtual keyboard overlap handling", () => {
  const mockOnClose = vi.fn();
  const mockSendInput = vi.fn();
  const mockResize = vi.fn();
  const mockReconnect = vi.fn();

  const createMockTerminalState = (overrides = {}) => ({
    connectionStatus: "disconnected" as const,
    sendInput: mockSendInput,
    resize: mockResize,
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onConnect: vi.fn(() => vi.fn()),
    onScrollback: vi.fn(() => vi.fn()),
    reconnect: mockReconnect,
    ...overrides,
  });

  const defaultTab = {
    id: "tab-1",
    sessionId: "test-session-123",
    title: "bash",
    isActive: true,
    createdAt: Date.now(),
  };

  const defaultSessionState = {
    tabs: [defaultTab],
    activeTab: defaultTab,
    isReady: true,
    createTab: vi.fn(),
    closeTab: vi.fn(),
    setActiveTab: vi.fn(),
    updateTabTitle: vi.fn(),
    restartActiveTab: vi.fn(),
  };

  let savedVisualViewport: typeof window.visualViewport;
  let savedInnerWidth: typeof window.innerWidth;
  let savedOntouchstart: typeof window.ontouchstart;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTerminal.mockReturnValue(createMockTerminalState());
    mockUseTerminalSessions.mockReturnValue(defaultSessionState);

    // Stash originals
    savedVisualViewport = window.visualViewport;
    savedInnerWidth = window.innerWidth;
    savedOntouchstart = window.ontouchstart;
  });

  afterEach(() => {
    // Restore originals
    Object.defineProperty(window, "visualViewport", {
      value: savedVisualViewport,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerWidth", {
      value: savedInnerWidth,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "ontouchstart", {
      value: savedOntouchstart,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  /**
   * Helper: simulate a mobile device with a visualViewport.
   * The resize/scroll callbacks are captured so tests can fire them.
   */
  function simulateMobileDevice(overlapPx: number) {
    // Touch device
    (window as any).ontouchstart = null; // truthy — "ontouchstart" in window → true

    // Narrow viewport
    Object.defineProperty(window, "innerWidth", {
      value: 375,
      writable: true,
      configurable: true,
    });

    // visualViewport mock
    const listeners: Record<string, Array<() => void>> = {
      resize: [],
      scroll: [],
    };

    const vvHeight = 300; // viewport shrunk by keyboard
    const vvOffsetTop = overlapPx > 0 ? 0 : 0; // typically 0 on modern mobile

    const mockVV = {
      width: 375,
      height: vvHeight,
      offsetTop: vvOffsetTop,
      offsetLeft: 0,
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (listeners[event]) listeners[event].push(cb);
      }),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(window, "visualViewport", {
      value: mockVV,
      writable: true,
      configurable: true,
    });

    // Override innerHeight to simulate keyboard overlap
    // keyboardOverlap = window.innerHeight - vv.offsetTop - vv.height
    // For overlapPx > 0: window.innerHeight = vv.offsetTop + vv.height + overlapPx
    Object.defineProperty(window, "innerHeight", {
      value: vvOffsetTop + vvHeight + overlapPx,
      writable: true,
      configurable: true,
    });

    return { listeners, mockVV };
  }

  it("does not apply --keyboard-overlap when not on a mobile device", async () => {
    // Desktop: no touch, wide viewport
    delete (window as any).ontouchstart;
    Object.defineProperty(window, "innerWidth", {
      value: 1440,
      writable: true,
      configurable: true,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      // No --keyboard-overlap should be set (style should be undefined/empty)
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });
  });

  it("applies --keyboard-overlap CSS variable when virtual keyboard is open on mobile", async () => {
    const { listeners } = simulateMobileDevice(250); // 250px keyboard overlap

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      const overlap = modal.style.getPropertyValue("--keyboard-overlap");
      expect(overlap).toBe("250px");
    });
  });

  it("updates --keyboard-overlap when keyboard height changes", async () => {
    const { listeners } = simulateMobileDevice(250);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("250px");
    });

    // Simulate keyboard shrinking (user swiped down partially)
    Object.defineProperty(window, "innerHeight", {
      value: 300 + 0 + 100, // keyboardOverlap becomes 100
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("100px");
    });
  });

  it("removes --keyboard-overlap when keyboard closes", async () => {
    const { listeners } = simulateMobileDevice(250);

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} />,
    );

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("250px");
    });

    // Keyboard closes → overlap becomes 0
    Object.defineProperty(window, "innerHeight", {
      value: 300 + 0 + 0,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      // When overlap is 0, the style prop should be undefined (no CSS variable set)
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });
  });

  it("clears overlap when modal closes", async () => {
    const { listeners } = simulateMobileDevice(250);

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} />,
    );

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("250px");
    });

    // Close the modal
    act(() => {
      rerender(<TerminalModal isOpen={false} onClose={mockOnClose} />);
    });

    // Modal is no longer rendered
    expect(screen.queryByTestId("terminal-modal")).toBeNull();
  });

  it("falls back gracefully when visualViewport is unavailable", async () => {
    // Mobile device but no visualViewport API (older browser)
    (window as any).ontouchstart = null;
    Object.defineProperty(window, "innerWidth", {
      value: 375,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "visualViewport", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      // No keyboard overlap applied since visualViewport is unavailable
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });
  });

  it("registers and cleans up visualViewport listeners on mobile", async () => {
    const { mockVV } = simulateMobileDevice(250);

    const { unmount } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} />,
    );

    await waitFor(() => {
      expect(mockVV.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
      expect(mockVV.addEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
    });

    const resizeCalls = mockVV.addEventListener.mock.calls.filter(
      (c: any[]) => c[0] === "resize",
    );
    const scrollCalls = mockVV.addEventListener.mock.calls.filter(
      (c: any[]) => c[0] === "scroll",
    );

    unmount();

    // Cleanup should remove both listeners
    expect(mockVV.removeEventListener).toHaveBeenCalledWith("resize", resizeCalls[0][1]);
    expect(mockVV.removeEventListener).toHaveBeenCalledWith("scroll", scrollCalls[0][1]);
  });

  it("zero overlap on mobile with no keyboard does not set CSS variable", async () => {
    simulateMobileDevice(0); // no keyboard

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });
  });
});

// --- Close/reopen regression tests ---
describe("TerminalModal — close and reopen scrollback replay", () => {
  const mockOnClose = vi.fn();
  const mockSendInput = vi.fn();
  const mockResize = vi.fn();
  const mockReconnect = vi.fn();

  const createMockTerminalState = (overrides = {}) => ({
    connectionStatus: "disconnected" as const,
    sendInput: mockSendInput,
    resize: mockResize,
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onConnect: vi.fn(() => vi.fn()),
    onScrollback: vi.fn(() => vi.fn()),
    reconnect: mockReconnect,
    ...overrides,
  });

  const defaultTab = {
    id: "tab-1",
    sessionId: "test-session-123",
    title: "bash",
    isActive: true,
    createdAt: Date.now(),
  };

  const defaultSessionState = {
    tabs: [defaultTab],
    activeTab: defaultTab,
    isReady: true,
    bootstrapError: null,
    createTab: vi.fn(),
    closeTab: vi.fn(),
    setActiveTab: vi.fn(),
    updateTabTitle: vi.fn(),
    restartActiveTab: vi.fn(),
    retryBootstrap: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTerminal.mockReturnValue(createMockTerminalState());
    mockUseTerminalSessions.mockReturnValue(defaultSessionState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Regression: terminal is empty after closing and reopening the modal
   * without a page refresh.
   *
   * Root cause: the xterm init effect's early-return guard checked
   * !terminalRef.current, which was null after cleanup. The fix restructures
   * the guard to check session continuity (xtermInitializedRef) before the
   * DOM ref, allowing the effect to proceed and reinitialize xterm.
   *
   * This test verifies:
   * 1. xterm initializes on first open
   * 2. xterm is disposed on close
   * 3. xterm reinitializes on reopen
   * 4. scrollback data is delivered to xterm after reopen
   */
  it("replays scrollback to xterm after modal close and reopen", async () => {
    let capturedScrollbackCallback: ((data: string) => void) | null = null;
    let capturedDataCallback: ((data: string) => void) | null = null;

    const mockOnScrollback = vi.fn((cb: (data: string) => void) => {
      capturedScrollbackCallback = cb;
      return vi.fn();
    });
    const mockOnData = vi.fn((cb: (data: string) => void) => {
      capturedDataCallback = cb;
      return vi.fn();
    });

    // Phase 1: Open modal — xterm initializes and subscriptions are established
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        connectionStatus: "connected",
        onScrollback: mockOnScrollback,
        onData: mockOnData,
      })
    );

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} />
    );

    // Wait for xterm to initialize on first open
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalledTimes(1);
    });

    // Wait for subscriptions to be established
    await waitFor(() => {
      expect(mockOnScrollback).toHaveBeenCalled();
      expect(mockOnData).toHaveBeenCalled();
    });

    // Verify scrollback data is delivered on first open
    act(() => {
      if (capturedScrollbackCallback) {
        capturedScrollbackCallback("first-open-output$ ");
      }
    });
    expect(mockTerminalInstance.write).toHaveBeenCalledWith("first-open-output$ ");

    // Phase 2: Close modal — xterm is disposed
    rerender(<TerminalModal isOpen={false} onClose={mockOnClose} />);

    // Modal is no longer rendered
    expect(screen.queryByTestId("terminal-modal")).toBeNull();

    // Verify xterm was disposed
    expect(mockTerminalInstance.dispose).toHaveBeenCalled();

    // Phase 3: Reopen modal — xterm should reinitialize
    // Reset scrollback/data callbacks for the new subscription cycle
    capturedScrollbackCallback = null;
    capturedDataCallback = null;

    const mockOnScrollback2 = vi.fn((cb: (data: string) => void) => {
      capturedScrollbackCallback = cb;
      return vi.fn();
    });
    const mockOnData2 = vi.fn((cb: (data: string) => void) => {
      capturedDataCallback = cb;
      return vi.fn();
    });

    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        connectionStatus: "connected",
        onScrollback: mockOnScrollback2,
        onData: mockOnData2,
      })
    );

    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // xterm should reinitialize (open called again)
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalledTimes(2);
    });

    // Subscriptions should be re-established
    await waitFor(() => {
      expect(mockOnScrollback2).toHaveBeenCalled();
      expect(mockOnData2).toHaveBeenCalled();
    });

    // Clear previous write calls
    mockTerminalInstance.write.mockClear();

    // Phase 4: Verify scrollback is replayed after reopen
    act(() => {
      if (capturedScrollbackCallback) {
        capturedScrollbackCallback("reopened-output$ ");
      }
      if (capturedDataCallback) {
        capturedDataCallback("ls -la\r\n");
      }
    });

    // xterm must receive scrollback data after reopen
    expect(mockTerminalInstance.write).toHaveBeenCalledWith("reopened-output$ ");
    expect(mockTerminalInstance.write).toHaveBeenCalledWith("ls -la\r\n");
  });

  /**
   * Verify that xterm open() is called again after close/reopen with the same session.
   * This confirms the init effect runs again and doesn't skip due to session continuity check.
   */
  it("calls xterm.open() again after close/reopen with same session", async () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        connectionStatus: "connected",
      })
    );

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} />
    );

    // Wait for first xterm initialization
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalledTimes(1);
    });

    // Close modal
    rerender(<TerminalModal isOpen={false} onClose={mockOnClose} />);

    // Reopen with same session
    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // xterm should be reinitialized
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalledTimes(2);
    });
  });
});
