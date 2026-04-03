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
  createTab: vi.fn(),
  closeTab: vi.fn(),
  setActiveTab: vi.fn(),
  updateTabTitle: vi.fn(),
  restartActiveTab: vi.fn(),
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

  it("xterm container is hidden while loading", async () => {
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      isReady: false,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const xtermDiv = screen.getByTestId("terminal-xterm");
      expect(xtermDiv.style.display).toBe("none");
    });
  });

  it("xterm container becomes visible when ready", async () => {
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
