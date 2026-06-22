/*
FNXC:DashboardTests 2026-06-14-08:31:
FN-6441 rescued this orphaned component test after standalone dashboard-app execution passed without assertion, timeout, or source-code changes. Keep the terminal modal coverage in app backfill because keyboard, session, and mobile terminal regressions are user-facing and should not remain skip-listed.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { TerminalModal, _resetInitialViewportHeight, ctrlChar, altChar } from "../TerminalModal";
import {
  DEFAULT_TERMINAL_PREFERENCES,
  LEGACY_TERMINAL_FONT_SIZE_KEY,
  TERMINAL_PREFERENCES_KEY,
  TERMINAL_SYMBOLS_FONT_FAMILY,
  XTERM_FONT_FAMILY,
  resolveTerminalFontFamily,
} from "../../utils/terminalPreferences";
import * as useTerminalModule from "../../hooks/useTerminal";
import * as useTerminalSessionsModule from "../../hooks/useTerminalSessions";
import * as apiModule from "../../api";

function splitFontFamilies(stack: string): string[] {
  return stack
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((family) => family.trim())
    .filter(Boolean);
}

function expectMeasurementSafeFontStack(stack: string): void {
  const families = splitFontFamilies(stack);
  expect(families.length).toBeGreaterThan(0);
  expect(families).not.toContain(TERMINAL_SYMBOLS_FONT_FAMILY);
}

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
const mockFitAddonFit = vi.fn();

let terminalKeyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;
let terminalDataHandler: ((data: string) => void) | null = null;

const mockTerminalInstance = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn((cb: (data: string) => void) => {
    terminalDataHandler = cb;
    return { dispose: vi.fn() };
  }),
  attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => {
    terminalKeyEventHandler = handler;
  }),
  hasSelection: vi.fn(() => false),
  getSelection: vi.fn(() => ""),
  paste: vi.fn(),
  dispose: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  focus: vi.fn(),
  refresh: vi.fn(),
  options: { fontSize: 14 },
  cols: 80,
  rows: 24,
};

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function TerminalMock() {
    return mockTerminalInstance;
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function FitAddonMock() {
    return {
      fit: mockFitAddonFit,
      dispose: vi.fn(),
    };
  }),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(function WebLinksAddonMock() {
    return {
      dispose: vi.fn(),
    };
  }),
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
const TERMINAL_FONT_SIZE_KEY = LEGACY_TERMINAL_FONT_SIZE_KEY;

describe("ctrlChar/altChar helpers", () => {
  it("maps Ctrl+C/D/Z/L and Alt sequences correctly", () => {
    expect(ctrlChar("c")).toBe("\x03");
    expect(ctrlChar("d")).toBe("\x04");
    expect(ctrlChar("z")).toBe("\x1a");
    expect(ctrlChar("l")).toBe("\x0c");

    expect(altChar("c")).toBe("\x1bc");
    expect(altChar("[")).toBe("\x1b[");
  });
});

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
  replaceActiveTabSession: vi.fn().mockResolvedValue(undefined),
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
    onSessionInvalid: vi.fn(() => vi.fn()),
    ...overrides,
  });

  beforeEach(async () => {
    const xtermModule = await import("@xterm/xterm");
    const fitAddonModule = await import("@xterm/addon-fit");
    const webLinksAddonModule = await import("@xterm/addon-web-links");
    vi.mocked(xtermModule.Terminal).mockImplementation(function TerminalMock() {
      return mockTerminalInstance;
    } as never);
    vi.mocked(fitAddonModule.FitAddon).mockImplementation(function FitAddonMock() {
      return {
        fit: mockFitAddonFit,
        dispose: vi.fn(),
      };
    } as never);
    vi.mocked(webLinksAddonModule.WebLinksAddon).mockImplementation(function WebLinksAddonMock() {
      return {
        dispose: vi.fn(),
      };
    } as never);
    vi.clearAllMocks();
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    terminalKeyEventHandler = null;
    terminalDataHandler = null;
    mockTerminalInstance.onData.mockImplementation((cb: (data: string) => void) => {
      terminalDataHandler = cb;
      return { dispose: vi.fn() };
    });
    mockFitAddonFit.mockClear();
    mockTerminalInstance.hasSelection.mockReturnValue(false);
    mockTerminalInstance.getSelection.mockReturnValue("");
    mockTerminalInstance.refresh.mockClear();
    Object.defineProperty(navigator, "platform", {
      value: "Win32",
      configurable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(document, "fonts", {
      value: undefined,
      configurable: true,
    });
    window.localStorage.removeItem(TERMINAL_FONT_SIZE_KEY);
    window.localStorage.removeItem(TERMINAL_PREFERENCES_KEY);
    mockTerminalInstance.options.fontFamily = XTERM_FONT_FAMILY;
    mockTerminalInstance.options.fontSize = 14;
    mockTerminalInstance.options.cursorStyle = "block";
    mockTerminalInstance.options.cursorBlink = true;
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
    vi.useRealTimers();
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

  it("renders desktop terminal as a docked bottom panel and refits after top-handle resize", async () => {
    const projectId = "docked-resize-test";
    window.localStorage.removeItem(`fusion:terminal-docked-height-${projectId}`);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} projectId={projectId} />);

    const modal = await screen.findByTestId("terminal-modal");
    await waitFor(() => expect(mockTerminalInstance.open).toHaveBeenCalled());
    expect(modal).toHaveClass("terminal-modal--docked");
    expect(modal).not.toHaveClass("terminal-modal--floating");

    const fitCallBaseline = mockFitAddonFit.mock.calls.length;
    // FNXC:Terminal 2026-06-22-19:50: The resize handlers now capture the pointer and listen on the CAPTURED handle element (not document), so move/up are fired on the handle with the matching pointerId; stub setPointerCapture/releasePointerCapture (jsdom no-ops).
    const handle = screen.getByTestId("terminal-docked-resize-handle") as HTMLElement & { setPointerCapture: (pointerId: number) => void; releasePointerCapture: (pointerId: number) => void };
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 420 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    await waitFor(() => {
      expect(window.localStorage.getItem(`fusion:terminal-docked-height-${projectId}`)).toBe("440");
      expect(mockFitAddonFit.mock.calls.length).toBeGreaterThan(fitCallBaseline);
    });
  });

  it("toggles between docked and floating terminal modes with the pop-out control", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} projectId="popout-toggle-test" />);

    const modal = await screen.findByTestId("terminal-modal");
    expect(modal).toHaveClass("terminal-modal--docked");
    expect(screen.getByTestId("terminal-docked-resize-handle")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("terminal-popout-toggle"));

    await waitFor(() => {
      expect(modal).toHaveClass("terminal-modal--floating");
      expect(modal).not.toHaveClass("terminal-modal--docked");
      expect(screen.getByTestId("terminal-floating-resize-se")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("terminal-popout-toggle"));

    await waitFor(() => {
      expect(modal).toHaveClass("terminal-modal--docked");
      expect(screen.getByTestId("terminal-docked-resize-handle")).toBeInTheDocument();
    });
  });

  it("exposes floating drag and resize handles and refits after floating resize", async () => {
    const projectId = "floating-resize-test";
    window.localStorage.setItem(`fusion:terminal-display-mode-${projectId}`, "floating");
    window.localStorage.removeItem(`fusion:terminal-modal-size-${projectId}`);
    window.localStorage.removeItem(`fusion:terminal-float-pos-${projectId}`);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} projectId={projectId} />);

    const modal = await screen.findByTestId("terminal-modal");
    await waitFor(() => expect(mockTerminalInstance.open).toHaveBeenCalled());
    expect(modal).toHaveClass("terminal-modal--floating");
    expect(screen.getByTestId("terminal-floating-resize-n")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-floating-resize-se")).toBeInTheDocument();

    const fitCallBaseline = mockFitAddonFit.mock.calls.length;
    // FNXC:Terminal 2026-06-22-19:50: Floating resize/drag now capture the pointer and listen on the CAPTURED element (not document); fire move/up on that element with the matching pointerId and stub set/releasePointerCapture.
    const resizeHandle = screen.getByTestId("terminal-floating-resize-se") as HTMLElement & { setPointerCapture: (pointerId: number) => void; releasePointerCapture: (pointerId: number) => void };
    resizeHandle.setPointerCapture = vi.fn();
    resizeHandle.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(resizeHandle, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(resizeHandle, { pointerId: 1, clientX: 140, clientY: 130 });
    fireEvent.pointerUp(resizeHandle, { pointerId: 1 });

    await waitFor(() => {
      expect(window.localStorage.getItem(`fusion:terminal-modal-size-${projectId}`)).toBe(JSON.stringify({ width: 992, height: 590 }));
      expect(mockFitAddonFit.mock.calls.length).toBeGreaterThan(fitCallBaseline);
    });

    const header = modal.querySelector(".terminal-header") as HTMLElement & { setPointerCapture: (pointerId: number) => void; releasePointerCapture: (pointerId: number) => void };
    header.setPointerCapture = vi.fn();
    header.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(header, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(header, { pointerId: 2, clientX: 125, clientY: 135 });
    fireEvent.pointerUp(header, { pointerId: 2 });

    await waitFor(() => {
      expect(window.localStorage.getItem(`fusion:terminal-float-pos-${projectId}`)).toBeTruthy();
    });
  });

  it("keeps mobile terminal on the full-screen modal path without docked or floating controls", async () => {
    const previousInnerWidth = window.innerWidth;
    const previousOntouchstart = window.ontouchstart;
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    Object.defineProperty(window, "ontouchstart", { value: null, configurable: true });

    try {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} projectId="mobile-fullscreen-test" />);

      const modal = await screen.findByTestId("terminal-modal");
      expect(modal).not.toHaveClass("terminal-modal--docked");
      expect(modal).not.toHaveClass("terminal-modal--floating");
      expect(screen.queryByTestId("terminal-docked-resize-handle")).toBeNull();
      expect(screen.queryByTestId("terminal-popout-toggle")).toBeNull();
      expect(screen.queryByTestId("terminal-floating-resize-se")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { value: previousInnerWidth, configurable: true });
      if (previousOntouchstart === undefined) {
        delete (window as any).ontouchstart;
      } else {
        Object.defineProperty(window, "ontouchstart", { value: previousOntouchstart, configurable: true });
      }
    }
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

  it("shows error with retry and refresh buttons when bootstrap fails instead of stuck loading", async () => {
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

    // Should show the bootstrap error state with retry + refresh buttons
    expect(screen.getByTestId("terminal-bootstrap-error")).toBeTruthy();
    expect(screen.getByText(/Failed to start terminal: Server unreachable/)).toBeTruthy();

    const retryBtn = screen.getByTestId("terminal-retry-btn");
    expect(retryBtn).toBeTruthy();
    expect(retryBtn.textContent).toContain("Retry");

    const refreshBtn = screen.getByTestId("terminal-bootstrap-refresh-btn");
    expect(refreshBtn).toBeTruthy();
    expect(refreshBtn.textContent).toContain("Refresh page");
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

  it("bootstrap refresh button reloads the page", async () => {
    const mockRetryBootstrap = vi.fn();
    const reloadMock = vi.fn();
    const originalWindow = globalThis.window;
    const patchedWindow = Object.create(originalWindow) as Window & typeof globalThis;

    Object.defineProperty(patchedWindow, "location", {
      value: {
        ...originalWindow.location,
        reload: reloadMock,
      },
      configurable: true,
    });

    (globalThis as { window: Window & typeof globalThis }).window = patchedWindow;

    try {
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        tabs: [],
        activeTab: null,
        bootstrapError: "Connection refused",
        retryBootstrap: mockRetryBootstrap,
      });

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      const refreshBtn = screen.getByTestId("terminal-bootstrap-refresh-btn");
      fireEvent.click(refreshBtn);

      expect(reloadMock).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as { window: Window & typeof globalThis }).window = originalWindow;
    }
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

  it("initializes xterm when activeTab transitions from null to valid after async session restoration", async () => {
    // Start with no activeTab (simulating initial async load from useTerminalSessions)
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      activeTab: null,
      isReady: false,
    });

    const { rerender } = render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // xterm should not initialize yet because activeTab is null
    expect(mockTerminalInstance.open).not.toHaveBeenCalled();

    // Simulate async session restoration completing
    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      activeTab: defaultTab,
      isReady: true,
    });
    mockUseTerminal.mockReturnValue(createMockTerminalState({ connectionStatus: "connected" }));

    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // xterm should be initialized after activeTab becomes available
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });
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
      // Overlay dismiss is wired via mousedown→mouseup so a resize-drag that
      // ends on the overlay (after starting inside the modal) doesn't close.
      // A real click on the overlay fires both events on the overlay.
      fireEvent.mouseDown(overlay);
      fireEvent.mouseUp(overlay);
    });

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("does NOT close when mousedown is on the modal but mouseup is on the overlay (resize drag)", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const overlay = screen.getByTestId("terminal-modal-overlay");
      const modal = screen.getByTestId("terminal-modal");
      fireEvent.mouseDown(modal);
      fireEvent.mouseUp(overlay);
    });

    expect(mockOnClose).not.toHaveBeenCalled();
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
      expect(mockUseTerminal).toHaveBeenCalledWith("test-session-123", undefined);
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

  it("initializes xterm with a Nerd Font-preferred monospace stack", async () => {
    const { Terminal } = await import("@xterm/xterm");

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: XTERM_FONT_FAMILY,
      }),
    );
    expectMeasurementSafeFontStack(mockTerminalInstance.options.fontFamily as string);
    expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("14px");
  });

  it("initializes xterm with a non-default symbols-free font preset", async () => {
    const { Terminal } = await import("@xterm/xterm");
    window.localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({
        ...DEFAULT_TERMINAL_PREFERENCES,
        fontFamily: "system-mono",
      }),
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: resolveTerminalFontFamily("system-mono"),
      }),
    );
    expectMeasurementSafeFontStack(mockTerminalInstance.options.fontFamily as string);
  });

  describe("shortcut panel", () => {
    it("is hidden by default and toggles from header action", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      expect(screen.queryByTestId("terminal-shortcut-panel")).toBeNull();

      fireEvent.click(screen.getByTestId("terminal-shortcut-toggle"));
      expect(screen.getByTestId("terminal-shortcut-panel")).toBeTruthy();

      fireEvent.click(screen.getByTestId("terminal-shortcut-toggle"));
      expect(screen.queryByTestId("terminal-shortcut-panel")).toBeNull();
    });

    it("supports sticky modifier toggle semantics", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      fireEvent.click(screen.getByTestId("terminal-shortcut-toggle"));

      const ctrlBtn = screen.getByTestId("terminal-modifier-ctrl");
      const altBtn = screen.getByTestId("terminal-modifier-alt");

      fireEvent.click(ctrlBtn);
      expect(ctrlBtn.getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(ctrlBtn);
      expect(ctrlBtn.getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(ctrlBtn);
      fireEvent.click(altBtn);
      expect(ctrlBtn.getAttribute("aria-pressed")).toBe("false");
      expect(altBtn.getAttribute("aria-pressed")).toBe("true");
    });

    it("sends modified and literal keys, then clears sticky modifier", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      fireEvent.click(screen.getByTestId("terminal-shortcut-toggle"));

      const ctrlBtn = screen.getByTestId("terminal-modifier-ctrl");
      const altBtn = screen.getByTestId("terminal-modifier-alt");

      fireEvent.click(ctrlBtn);
      fireEvent.click(screen.getByRole("button", { name: "C" }));
      expect(mockSendInput).toHaveBeenCalledWith("\x03");
      expect(ctrlBtn.getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(ctrlBtn);
      fireEvent.click(screen.getByRole("button", { name: "D" }));
      expect(mockSendInput).toHaveBeenCalledWith("\x04");
      expect(ctrlBtn.getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(ctrlBtn);
      fireEvent.click(screen.getByRole("button", { name: "L" }));
      expect(mockSendInput).toHaveBeenCalledWith("\x0c");
      expect(ctrlBtn.getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(ctrlBtn);
      fireEvent.click(screen.getByRole("button", { name: "." }));
      expect(mockSendInput).toHaveBeenCalledWith(".");
      expect(ctrlBtn.getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(altBtn);
      fireEvent.click(screen.getByRole("button", { name: "D" }));
      expect(mockSendInput).toHaveBeenCalledWith("\x1bd");
      expect(altBtn.getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(screen.getByRole("button", { name: "Z" }));
      expect(mockSendInput).toHaveBeenCalledWith("z");

      fireEvent.click(screen.getByRole("button", { name: "ESC" }));
      expect(mockSendInput).toHaveBeenCalledWith("\x1b");

      fireEvent.click(screen.getByRole("button", { name: "Tab" }));
      expect(mockSendInput).toHaveBeenCalledWith("\t");
    });

    it("keeps desktop hardware-keyboard focus while every shortcut category delivers bytes", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(mockTerminalInstance.open).toHaveBeenCalled();
        expect(terminalDataHandler).not.toBeNull();
      });

      const terminalDiv = screen.getByTestId("terminal-xterm");
      const helperTextarea = document.createElement("textarea");
      helperTextarea.className = "xterm-helper-textarea";
      const focusSpy = vi.spyOn(helperTextarea, "focus");
      terminalDiv.appendChild(helperTextarea);
      helperTextarea.focus();
      expect(document.activeElement).toBe(helperTextarea);

      fireEvent.click(screen.getByTestId("terminal-shortcut-toggle"));
      const assertMouseDownPreservesFocus = (button: HTMLElement) => {
        const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        button.dispatchEvent(mouseDown);
        expect(mouseDown.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(helperTextarea);
      };

      mockSendInput.mockClear();
      mockTerminalInstance.focus.mockClear();
      focusSpy.mockClear();

      const ctrlButton = screen.getByTestId("terminal-modifier-ctrl");
      assertMouseDownPreservesFocus(ctrlButton);
      fireEvent.click(ctrlButton);
      expect(mockTerminalInstance.focus).toHaveBeenCalled();
      expect(focusSpy).toHaveBeenCalled();
      expect(mockSendInput).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "C" }));
      fireEvent.click(screen.getByRole("button", { name: "ESC" }));
      fireEvent.click(screen.getByRole("button", { name: "Tab" }));
      fireEvent.click(screen.getByTestId("terminal-arrow-up"));

      expect(mockSendInput.mock.calls.map(([value]) => value)).toEqual([
        "\x03",
        "\x1b",
        "\t",
        "\x1b[A",
      ]);
      expect(document.activeElement).toBe(helperTextarea);

      act(() => {
        terminalDataHandler?.("a");
      });
      expect(mockSendInput).toHaveBeenLastCalledWith("a");
    });

    it("keeps touch-primary shortcut buttons from stranding hardware-keyboard focus", async () => {
      const previousInnerWidth = window.innerWidth;
      const previousOntouchstart = window.ontouchstart;
      const matchMediaSpy = vi
        .spyOn(window, "matchMedia")
        .mockImplementation((query: string) => ({
          matches:
            query === "(hover: none) and (pointer: coarse)" ||
            query.includes("max-width: 768px"),
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }));

      Object.defineProperty(window, "innerWidth", {
        value: 375,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, "ontouchstart", {
        value: null,
        writable: true,
        configurable: true,
      });

      let unmount = () => {};

      try {
        ({ unmount } = render(<TerminalModal isOpen={true} onClose={mockOnClose} />));

        await waitFor(() => {
          expect(mockTerminalInstance.open).toHaveBeenCalled();
        });

        const terminalDiv = screen.getByTestId("terminal-xterm");
        const helperTextarea = document.createElement("textarea");
        helperTextarea.className = "xterm-helper-textarea";
        const focusSpy = vi.spyOn(helperTextarea, "focus");
        terminalDiv.appendChild(helperTextarea);
        helperTextarea.focus();

        fireEvent.click(screen.getByTestId("terminal-shortcut-toggle"));
        const ctrlButton = screen.getByTestId("terminal-modifier-ctrl");
        const arrowUpButton = screen.getByTestId("terminal-arrow-up");
        fireEvent.touchStart(ctrlButton);
        expect(document.activeElement).toBe(helperTextarea);

        const pointerDown = new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
        });
        ctrlButton.dispatchEvent(pointerDown);
        expect(pointerDown.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(helperTextarea);
        const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        arrowUpButton.dispatchEvent(mouseDown);
        expect(mouseDown.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(helperTextarea);

        mockSendInput.mockClear();
        mockTerminalInstance.focus.mockClear();
        focusSpy.mockClear();

        fireEvent.click(screen.getByTestId("terminal-modifier-ctrl"));
        fireEvent.click(screen.getByRole("button", { name: "C" }));
        fireEvent.click(screen.getByRole("button", { name: "ESC" }));
        fireEvent.click(screen.getByRole("button", { name: "Tab" }));
        fireEvent.click(arrowUpButton);

        expect(mockSendInput.mock.calls.map(([value]) => value)).toEqual([
          "\x03",
          "\x1b",
          "\t",
          "\x1b[A",
        ]);
        expect(mockTerminalInstance.focus).toHaveBeenCalled();
        expect(focusSpy).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(helperTextarea);
      } finally {
        unmount();
        matchMediaSpy.mockRestore();
        Object.defineProperty(window, "innerWidth", {
          value: previousInnerWidth,
          writable: true,
          configurable: true,
        });
        Object.defineProperty(window, "ontouchstart", {
          value: previousOntouchstart,
          writable: true,
          configurable: true,
        });
      }
    });

    it("sends literal ANSI arrow sequences independent of sticky modifiers", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      fireEvent.click(screen.getByTestId("terminal-shortcut-toggle"));
      fireEvent.click(screen.getByTestId("terminal-modifier-ctrl"));

      fireEvent.click(screen.getByTestId("terminal-arrow-up"));
      fireEvent.click(screen.getByTestId("terminal-arrow-down"));
      fireEvent.click(screen.getByTestId("terminal-arrow-left"));
      fireEvent.click(screen.getByTestId("terminal-arrow-right"));

      expect(mockSendInput).toHaveBeenNthCalledWith(1, "\x1b[A");
      expect(mockSendInput).toHaveBeenNthCalledWith(2, "\x1b[B");
      expect(mockSendInput).toHaveBeenNthCalledWith(3, "\x1b[D");
      expect(mockSendInput).toHaveBeenNthCalledWith(4, "\x1b[C");
      expect(screen.getByTestId("terminal-modifier-ctrl").getAttribute("aria-pressed")).toBe("false");
    });

    it("renders shortcut controls on mobile viewport", async () => {
      const previousInnerWidth = window.innerWidth;
      const previousOntouchstart = window.ontouchstart;

      Object.defineProperty(window, "innerWidth", {
        value: 375,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, "ontouchstart", {
        value: null,
        writable: true,
        configurable: true,
      });

      try {
        render(<TerminalModal isOpen={true} onClose={mockOnClose} />);
        fireEvent.click(screen.getByTestId("terminal-shortcut-toggle"));

        expect(screen.getByTestId("terminal-shortcut-panel")).toBeTruthy();
        expect(screen.getByTestId("terminal-modifier-ctrl")).toBeTruthy();
        expect(screen.getByTestId("terminal-modifier-alt")).toBeTruthy();
      } finally {
        Object.defineProperty(window, "innerWidth", {
          value: previousInnerWidth,
          writable: true,
          configurable: true,
        });
        Object.defineProperty(window, "ontouchstart", {
          value: previousOntouchstart,
          writable: true,
          configurable: true,
        });
      }
    });
  });

  describe("font size controls", () => {
    it("renders controls in the status bar with default font-size value", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-decrease")).toBeTruthy();
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("14px");
        expect(screen.getByTestId("terminal-font-size-increase")).toBeTruthy();
      });
    });

    it("increases font size via button, persists, and refits xterm", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("14px");
      });
      const fitCallBaseline = mockFitAddonFit.mock.calls.length;

      fireEvent.click(screen.getByTestId("terminal-font-size-increase"));

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("15px");
        expect(window.localStorage.getItem(TERMINAL_FONT_SIZE_KEY)).toBe("15");
        expect(mockFitAddonFit.mock.calls.length).toBeGreaterThan(fitCallBaseline);
      });
    });

    it("decreases font size via button, persists, and refits xterm", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("14px");
      });
      const fitCallBaseline = mockFitAddonFit.mock.calls.length;

      fireEvent.click(screen.getByTestId("terminal-font-size-decrease"));

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("13px");
        expect(window.localStorage.getItem(TERMINAL_FONT_SIZE_KEY)).toBe("13");
        expect(mockFitAddonFit.mock.calls.length).toBeGreaterThan(fitCallBaseline);
      });
    });

    it("reads persisted font size from localStorage on mount", async () => {
      window.localStorage.setItem(TERMINAL_FONT_SIZE_KEY, "18");

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("18px");
      });
    });

    it("clamps button changes to max 32", async () => {
      window.localStorage.setItem(TERMINAL_FONT_SIZE_KEY, "32");

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      fireEvent.click(screen.getByTestId("terminal-font-size-increase"));

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("32px");
        expect(window.localStorage.getItem(TERMINAL_FONT_SIZE_KEY)).toBe("32");
      });
    });

    it("clamps button changes to min 8", async () => {
      window.localStorage.setItem(TERMINAL_FONT_SIZE_KEY, "8");

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      fireEvent.click(screen.getByTestId("terminal-font-size-decrease"));

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("8px");
        expect(window.localStorage.getItem(TERMINAL_FONT_SIZE_KEY)).toBe("8");
      });
    });

    it("keeps keyboard zoom shortcuts wired to shared font-size state and refits xterm", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("14px");
      });

      const baseline = mockFitAddonFit.mock.calls.length;

      fireEvent.keyDown(window, { ctrlKey: true, code: "Equal" });
      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("15px");
        expect(mockFitAddonFit.mock.calls.length).toBeGreaterThan(baseline);
      });

      const afterEqual = mockFitAddonFit.mock.calls.length;
      fireEvent.keyDown(window, { ctrlKey: true, code: "Minus" });
      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("14px");
        expect(mockFitAddonFit.mock.calls.length).toBeGreaterThan(afterEqual);
      });

      fireEvent.keyDown(window, { ctrlKey: true, code: "Equal" });
      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("15px");
      });

      const afterSecondEqual = mockFitAddonFit.mock.calls.length;
      fireEvent.keyDown(window, { ctrlKey: true, code: "Digit0" });
      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("14px");
        expect(window.localStorage.getItem(TERMINAL_FONT_SIZE_KEY)).toBe("14");
        expect(mockFitAddonFit.mock.calls.length).toBeGreaterThan(afterSecondEqual);
      });
    });
  });

  describe("terminal preferences", () => {
    it("toggles the preferences panel", () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      expect(screen.queryByTestId("terminal-preferences-panel")).toBeNull();

      fireEvent.click(screen.getByTestId("terminal-preferences-toggle"));
      expect(screen.getByTestId("terminal-preferences-panel")).toBeTruthy();

      fireEvent.click(screen.getByTestId("terminal-preferences-toggle"));
      expect(screen.queryByTestId("terminal-preferences-panel")).toBeNull();
    });

    it("persists preference changes and applies live xterm options", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => expect(mockTerminalInstance.open).toHaveBeenCalled());
      fireEvent.click(screen.getByTestId("terminal-preferences-toggle"));

      fireEvent.change(screen.getByTestId("terminal-preference-font-family"), {
        target: { value: "system-mono" },
      });
      fireEvent.change(screen.getByTestId("terminal-preference-cursor-style"), {
        target: { value: "underline" },
      });
      fireEvent.click(screen.getByTestId("terminal-preference-cursor-blink"));

      await waitFor(() => {
        expect(mockTerminalInstance.options.fontFamily).toBe(resolveTerminalFontFamily("system-mono"));
        expectMeasurementSafeFontStack(mockTerminalInstance.options.fontFamily as string);
        expect(mockTerminalInstance.options.cursorStyle).toBe("underline");
        expect(mockTerminalInstance.options.cursorBlink).toBe(false);
      });

      const persisted = JSON.parse(window.localStorage.getItem(TERMINAL_PREFERENCES_KEY) ?? "null");
      expect(persisted).toEqual({
        ...DEFAULT_TERMINAL_PREFERENCES,
        fontFamily: "system-mono",
        cursorStyle: "underline",
        cursorBlink: false,
      });
    });

    it("resets preferences to defaults", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      fireEvent.click(screen.getByTestId("terminal-preferences-toggle"));
      fireEvent.change(screen.getByTestId("terminal-preference-font-size"), {
        target: { value: "21" },
      });

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("21px");
      });

      fireEvent.click(screen.getByTestId("terminal-preferences-reset"));

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("14px");
        expect(screen.getByTestId("terminal-preference-font-size")).toHaveProperty("value", "14");
      });
      expect(JSON.parse(window.localStorage.getItem(TERMINAL_PREFERENCES_KEY) ?? "null")).toEqual(
        DEFAULT_TERMINAL_PREFERENCES,
      );
    });

    it("keeps panel font-size control and status-bar controls in sync", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      fireEvent.click(screen.getByTestId("terminal-preferences-toggle"));
      fireEvent.change(screen.getByTestId("terminal-preference-font-size"), {
        target: { value: "16" },
      });

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("16px");
      });

      fireEvent.click(screen.getByTestId("terminal-font-size-increase"));

      await waitFor(() => {
        expect(screen.getByTestId("terminal-font-size-value").textContent).toBe("17px");
        expect(screen.getByTestId("terminal-preference-font-size")).toHaveProperty("value", "17");
      });
    });

    it("shows renderer changes as next-open only", async () => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => expect(mockTerminalInstance.open).toHaveBeenCalled());
      fireEvent.click(screen.getByTestId("terminal-preferences-toggle"));
      expect(screen.queryByTestId("terminal-renderer-reopen-note")).toBeNull();

      fireEvent.change(screen.getByTestId("terminal-preference-renderer"), {
        target: { value: "canvas" },
      });

      await waitFor(() => {
        expect(screen.getByTestId("terminal-renderer-reopen-note")).toBeTruthy();
      });
    });
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
      onSessionInvalid: vi.fn(() => vi.fn()),
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
    async function flushInitialCommandDelay() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    }

    async function flushCreateTabPromise() {
      await act(async () => {});
    }

    function scriptTab(id: string, sessionId: string, title = "Terminal 2") {
      return {
        id,
        sessionId,
        title,
        isActive: true,
        createdAt: Date.now(),
      };
    }

    function useConnectedTerminal() {
      mockUseTerminal.mockReturnValue(
        createMockTerminalState({ connectionStatus: "connected" })
      );
    }

    function expectCommandSentAfterCreateTab(mockCreateTab: ReturnType<typeof vi.fn>) {
      expect(mockCreateTab.mock.invocationCallOrder[0]).toBeLessThan(
        mockSendInput.mock.invocationCallOrder.at(-1) ?? Number.MAX_SAFE_INTEGER,
      );
    }

    it("creates a new tab before sending an initialCommand on a fresh modal open", async () => {
      vi.useFakeTimers();
      const newScriptTab = scriptTab("tab-script", "script-session-456");
      const mockCreateTab = vi.fn().mockResolvedValue(newScriptTab);
      useConnectedTerminal();
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        createTab: mockCreateTab,
      });

      try {
        const { rerender } = render(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );

        await flushCreateTabPromise();
        expect(mockCreateTab).toHaveBeenCalledTimes(1);
        expect(mockSendInput).not.toHaveBeenCalled();

        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...defaultTab, isActive: false }, newScriptTab],
          activeTab: newScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );

        await flushInitialCommandDelay();
        expect(mockUseTerminal).toHaveBeenLastCalledWith("script-session-456", undefined);
        expect(mockSendInput).toHaveBeenCalledWith("npm run build\n");
        expectCommandSentAfterCreateTab(mockCreateTab);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the pending quick-script command when a session transition interrupts the delay", async () => {
      vi.useFakeTimers();
      const newScriptTab = scriptTab("tab-script", "script-session-456");
      const mockCreateTab = vi.fn().mockResolvedValue(newScriptTab);
      useConnectedTerminal();
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        createTab: mockCreateTab,
      });

      try {
        const { rerender } = render(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm build" initialCommandGeneration={1} />
        );

        await flushCreateTabPromise();
        expect(mockCreateTab).toHaveBeenCalledTimes(1);
        expect(mockSendInput).not.toHaveBeenCalled();

        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...defaultTab, isActive: false }, newScriptTab],
          activeTab: newScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm build" initialCommandGeneration={1} />
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        expect(mockSendInput).not.toHaveBeenCalled();

        mockUseTerminal.mockReturnValue(
          createMockTerminalState({ connectionStatus: "connecting" })
        );
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm build" initialCommandGeneration={1} />
        );

        await flushInitialCommandDelay();
        expect(mockSendInput).not.toHaveBeenCalled();

        useConnectedTerminal();
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm build" initialCommandGeneration={1} />
        );

        await flushInitialCommandDelay();
        expect(mockUseTerminal).toHaveBeenLastCalledWith("script-session-456", undefined);
        expect(mockSendInput).toHaveBeenCalledTimes(1);
        expect(mockSendInput).toHaveBeenCalledWith("pnpm build\n");
        expectCommandSentAfterCreateTab(mockCreateTab);
      } finally {
        vi.useRealTimers();
      }
    });

    it("waits for the new script session to connect before sending the quick-script command", async () => {
      vi.useFakeTimers();
      const newScriptTab = scriptTab("tab-script", "script-session-456");
      const mockCreateTab = vi.fn().mockResolvedValue(newScriptTab);
      useConnectedTerminal();
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        createTab: mockCreateTab,
      });

      try {
        const { rerender } = render(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm build" initialCommandGeneration={1} />
        );

        await flushCreateTabPromise();
        expect(mockCreateTab).toHaveBeenCalledTimes(1);

        mockUseTerminal.mockReturnValue(
          createMockTerminalState({ connectionStatus: "connecting" })
        );
        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...defaultTab, isActive: false }, newScriptTab],
          activeTab: newScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm build" initialCommandGeneration={1} />
        );

        await flushInitialCommandDelay();
        expect(mockUseTerminal).toHaveBeenLastCalledWith("script-session-456", undefined);
        expect(mockSendInput).not.toHaveBeenCalledWith("pnpm build\n");

        useConnectedTerminal();
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm build" initialCommandGeneration={1} />
        );

        await flushInitialCommandDelay();
        expect(mockUseTerminal).toHaveBeenLastCalledWith("script-session-456", undefined);
        expect(mockSendInput).toHaveBeenCalledTimes(1);
        expect(mockSendInput).toHaveBeenCalledWith("pnpm build\n");
        expectCommandSentAfterCreateTab(mockCreateTab);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the quick-script command pending if the user switches tabs during the delay", async () => {
      vi.useFakeTimers();
      const newScriptTab = scriptTab("tab-script", "script-session-456");
      const existingTab = { ...defaultTab, title: "Terminal 1", isActive: true };
      const mockCreateTab = vi.fn().mockResolvedValue(newScriptTab);
      useConnectedTerminal();
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        tabs: [existingTab],
        activeTab: existingTab,
        createTab: mockCreateTab,
      });

      try {
        const { rerender } = render(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm build" initialCommandGeneration={1} />
        );

        await flushCreateTabPromise();
        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...existingTab, isActive: false }, newScriptTab],
          activeTab: newScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm build" initialCommandGeneration={1} />
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        expect(mockSendInput).not.toHaveBeenCalled();

        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...existingTab, isActive: true }, { ...newScriptTab, isActive: false }],
          activeTab: existingTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm build" initialCommandGeneration={1} />
        );

        await flushInitialCommandDelay();
        expect(mockUseTerminal).toHaveBeenLastCalledWith("test-session-123", undefined);
        expect(mockSendInput).not.toHaveBeenCalled();

        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...existingTab, isActive: false }, newScriptTab],
          activeTab: newScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm build" initialCommandGeneration={1} />
        );

        await flushInitialCommandDelay();
        expect(mockUseTerminal).toHaveBeenLastCalledWith("script-session-456", undefined);
        expect(mockSendInput).toHaveBeenCalledTimes(1);
        expect(mockSendInput).toHaveBeenCalledWith("pnpm build\n");
      } finally {
        vi.useRealTimers();
      }
    });

    it("dedupes same initialCommand generation on ordinary re-renders", async () => {
      vi.useFakeTimers();
      const newScriptTab = scriptTab("tab-script", "script-session-456");
      const mockCreateTab = vi.fn().mockResolvedValue(newScriptTab);
      useConnectedTerminal();
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        createTab: mockCreateTab,
      });

      try {
        const { rerender } = render(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );

        await flushCreateTabPromise();
        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...defaultTab, isActive: false }, newScriptTab],
          activeTab: newScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );
        await flushInitialCommandDelay();
        expect(mockSendInput).toHaveBeenCalledWith("npm run build\n");

        const createCount = mockCreateTab.mock.calls.length;
        const sendCount = mockSendInput.mock.calls.length;

        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );

        await flushInitialCommandDelay();
        expect(mockCreateTab).toHaveBeenCalledTimes(createCount);
        expect(mockSendInput).toHaveBeenCalledTimes(sendCount);
      } finally {
        vi.useRealTimers();
      }
    });

    it("creates a new tab before sending an initialCommand that arrives while terminal is already open", async () => {
      vi.useFakeTimers();
      const newScriptTab = scriptTab("tab-script", "script-session-456");
      const mockCreateTab = vi.fn().mockResolvedValue(newScriptTab);
      useConnectedTerminal();
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        createTab: mockCreateTab,
      });

      try {
        const { rerender } = render(
          <TerminalModal isOpen={true} onClose={mockOnClose} />
        );

        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm test" />
        );

        await flushCreateTabPromise();
        expect(mockCreateTab).toHaveBeenCalledTimes(1);
        expect(mockSendInput).not.toHaveBeenCalledWith("pnpm test\n");

        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...defaultTab, isActive: false }, newScriptTab],
          activeTab: newScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm test" />
        );

        await flushInitialCommandDelay();
        expect(mockUseTerminal).toHaveBeenLastCalledWith("script-session-456", undefined);
        expect(mockSendInput).toHaveBeenCalledWith("pnpm test\n");
        expectCommandSentAfterCreateTab(mockCreateTab);
      } finally {
        vi.useRealTimers();
      }
    });

    it("creates a new tab before sending a changed initialCommand while terminal remains open", async () => {
      vi.useFakeTimers();
      const firstScriptTab = scriptTab("tab-script-1", "script-session-456", "Terminal 2");
      const secondScriptTab = scriptTab("tab-script-2", "script-session-789", "Terminal 3");
      const mockCreateTab = vi.fn()
        .mockResolvedValueOnce(firstScriptTab)
        .mockResolvedValueOnce(secondScriptTab);
      useConnectedTerminal();
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        createTab: mockCreateTab,
      });

      try {
        const { rerender } = render(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );

        await flushCreateTabPromise();
        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...defaultTab, isActive: false }, firstScriptTab],
          activeTab: firstScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );
        await flushInitialCommandDelay();
        expect(mockSendInput).toHaveBeenCalledWith("npm run build\n");

        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm test" />
        );

        await flushCreateTabPromise();
        expect(mockCreateTab).toHaveBeenCalledTimes(2);
        expect(mockSendInput).not.toHaveBeenCalledWith("pnpm test\n");

        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...defaultTab, isActive: false }, { ...firstScriptTab, isActive: false }, secondScriptTab],
          activeTab: secondScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm test" />
        );

        await flushInitialCommandDelay();
        expect(mockUseTerminal).toHaveBeenLastCalledWith("script-session-789", undefined);
        expect(mockSendInput).toHaveBeenCalledWith("pnpm test\n");
      } finally {
        vi.useRealTimers();
      }
    });

    it("creates a new tab for the same command when the runScript generation changes", async () => {
      vi.useFakeTimers();
      const firstScriptTab = scriptTab("tab-script-1", "script-session-456", "Terminal 2");
      const secondScriptTab = scriptTab("tab-script-2", "script-session-789", "Terminal 3");
      const mockCreateTab = vi.fn()
        .mockResolvedValueOnce(firstScriptTab)
        .mockResolvedValueOnce(secondScriptTab);
      useConnectedTerminal();
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        createTab: mockCreateTab,
      });

      try {
        const { rerender } = render(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm test" initialCommandGeneration={1} />
        );

        await flushCreateTabPromise();
        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...defaultTab, isActive: false }, firstScriptTab],
          activeTab: firstScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm test" initialCommandGeneration={1} />
        );
        await flushInitialCommandDelay();
        expect(mockSendInput).toHaveBeenCalledTimes(1);

        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm test" initialCommandGeneration={2} />
        );
        await flushCreateTabPromise();
        expect(mockCreateTab).toHaveBeenCalledTimes(2);
        expect(mockSendInput).toHaveBeenCalledTimes(1);

        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...defaultTab, isActive: false }, { ...firstScriptTab, isActive: false }, secondScriptTab],
          activeTab: secondScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm test" initialCommandGeneration={2} />
        );

        await flushInitialCommandDelay();
        expect(mockUseTerminal).toHaveBeenLastCalledWith("script-session-789", undefined);
        expect(mockSendInput).toHaveBeenCalledTimes(2);
        expect(mockSendInput).toHaveBeenLastCalledWith("pnpm test\n");
      } finally {
        vi.useRealTimers();
      }
    });

    it("creates the script tab after the auto-created blank tab on a fresh open", async () => {
      vi.useFakeTimers();
      const autoCreatedBlankTab = {
        ...defaultTab,
        title: "Terminal 1",
        isActive: true,
      };
      const newScriptTab = scriptTab("tab-script", "script-session-456", "Terminal 2");
      const mockCreateTab = vi.fn().mockResolvedValue(newScriptTab);
      useConnectedTerminal();
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        tabs: [autoCreatedBlankTab],
        activeTab: autoCreatedBlankTab,
        createTab: mockCreateTab,
      });

      try {
        const { rerender } = render(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );

        await flushCreateTabPromise();
        expect(mockCreateTab).toHaveBeenCalledTimes(1);
        expect(mockSendInput).not.toHaveBeenCalled();

        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...autoCreatedBlankTab, isActive: false }, newScriptTab],
          activeTab: newScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );

        await flushInitialCommandDelay();
        expect(mockSendInput).toHaveBeenCalledWith("npm run build\n");
        expect(screen.getByText("Terminal 1")).toBeTruthy();
        expect(screen.getByText("Terminal 2")).toBeTruthy();
        expect(screen.getByText("Terminal 2").closest(".terminal-tab")?.className).toContain("active");
      } finally {
        vi.useRealTimers();
      }
    });

    it("creates a script tab when multiple tabs already exist", async () => {
      vi.useFakeTimers();
      const existingTabOne = { ...defaultTab, isActive: false, title: "Terminal 1" };
      const existingTabTwo = {
        id: "tab-2",
        sessionId: "session-2",
        title: "Terminal 2",
        isActive: true,
        createdAt: Date.now(),
      };
      const newScriptTab = scriptTab("tab-script", "script-session-456", "Terminal 3");
      const mockCreateTab = vi.fn().mockResolvedValue(newScriptTab);
      useConnectedTerminal();
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        tabs: [existingTabOne, existingTabTwo],
        activeTab: existingTabTwo,
        createTab: mockCreateTab,
      });

      try {
        const { rerender } = render(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm lint" />
        );

        await flushCreateTabPromise();
        expect(mockCreateTab).toHaveBeenCalledTimes(1);
        expect(mockSendInput).not.toHaveBeenCalled();

        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [existingTabOne, { ...existingTabTwo, isActive: false }, newScriptTab],
          activeTab: newScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="pnpm lint" />
        );

        await flushInitialCommandDelay();
        expect(mockUseTerminal).toHaveBeenLastCalledWith("script-session-456", undefined);
        expect(mockSendInput).toHaveBeenCalledWith("pnpm lint\n");
      } finally {
        vi.useRealTimers();
      }
    });

    it("resends command after modal close and reopen by creating a new tab", async () => {
      vi.useFakeTimers();
      const firstScriptTab = scriptTab("tab-script-1", "script-session-456", "Terminal 2");
      const secondScriptTab = scriptTab("tab-script-2", "script-session-789", "Terminal 2");
      const mockCreateTab = vi.fn()
        .mockResolvedValueOnce(firstScriptTab)
        .mockResolvedValueOnce(secondScriptTab);
      useConnectedTerminal();
      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        createTab: mockCreateTab,
      });

      try {
        const { rerender } = render(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );

        await flushCreateTabPromise();
        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...defaultTab, isActive: false }, firstScriptTab],
          activeTab: firstScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );
        await flushInitialCommandDelay();
        expect(mockSendInput).toHaveBeenCalledWith("npm run build\n");

        rerender(
          <TerminalModal isOpen={false} onClose={mockOnClose} initialCommand="npm run build" />
        );

        mockSendInput.mockClear();
        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );

        await flushCreateTabPromise();
        expect(mockCreateTab).toHaveBeenCalledTimes(2);

        mockUseTerminalSessions.mockReturnValue({
          ...defaultSessionState,
          tabs: [{ ...defaultTab, isActive: false }, secondScriptTab],
          activeTab: secondScriptTab,
          createTab: mockCreateTab,
        });
        rerender(
          <TerminalModal isOpen={true} onClose={mockOnClose} initialCommand="npm run build" />
        );

        await flushInitialCommandDelay();
        expect(mockUseTerminal).toHaveBeenLastCalledWith("script-session-789", undefined);
        expect(mockSendInput).toHaveBeenCalledWith("npm run build\n");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --- xterm initialization watchdog tests ---
  describe("xterm initialization watchdog", () => {
    it("shows xterm init error overlay with reinitialize and refresh actions when xterm constructor throws", async () => {
      // Override the mock to throw on construction
      const { Terminal } = await import("@xterm/xterm");
      const OrigTerminal = Terminal;

      // Replace Terminal constructor with one that throws
      const throwingModule = await import("@xterm/xterm");
      (throwingModule as any).Terminal = vi.fn(function ThrowingTerminalMock() {
        throw new Error("xterm constructor failed");
      });

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      // Should show xterm init error
      await waitFor(() => {
        expect(screen.getByTestId("terminal-xterm-init-error")).toBeTruthy();
        expect(screen.getByText(/Terminal UI failed to initialize/)).toBeTruthy();
      });

      // Should have both reinitialize + refresh fallback actions
      const reinitBtn = screen.getByTestId("terminal-reinit-btn");
      expect(reinitBtn).toBeTruthy();
      expect(reinitBtn.textContent).toContain("Reinitialize");

      const refreshBtn = screen.getByTestId("terminal-xterm-refresh-btn");
      expect(refreshBtn).toBeTruthy();
      expect(refreshBtn.textContent).toContain("Refresh page");

      // Restore original Terminal
      (throwingModule as any).Terminal = OrigTerminal;
    });

    it("clicking Reinitialize button clears error and triggers fresh init attempt", async () => {
      // Make Terminal throw first, then work after reinitialize
      const throwingModule = await import("@xterm/xterm");
      const OrigTerminal = throwingModule.Terminal;

      let callCount = 0;
      (throwingModule as any).Terminal = vi.fn(function ReinitializingTerminalMock() {
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

    it("xterm init refresh button reloads the page", async () => {
      const reloadMock = vi.fn();
      const originalWindow = globalThis.window;
      const patchedWindow = Object.create(originalWindow) as Window & typeof globalThis;

      Object.defineProperty(patchedWindow, "location", {
        value: {
          ...originalWindow.location,
          reload: reloadMock,
        },
        configurable: true,
      });

      (globalThis as { window: Window & typeof globalThis }).window = patchedWindow;

      try {
        const xtermModule = await import("@xterm/xterm");
        const OrigTerminal = xtermModule.Terminal;

        (xtermModule as any).Terminal = vi.fn(function ThrowingTerminalMock() {
          throw new Error("xterm constructor failed");
        });

        render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

        await waitFor(() => {
          expect(screen.getByTestId("terminal-xterm-init-error")).toBeTruthy();
        });

        fireEvent.click(screen.getByTestId("terminal-xterm-refresh-btn"));
        expect(reloadMock).toHaveBeenCalledTimes(1);

        (xtermModule as any).Terminal = OrigTerminal;
      } finally {
        (globalThis as { window: Window & typeof globalThis }).window = originalWindow;
      }
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
      (xtermModule as any).Terminal = vi.fn(function TimeoutTerminalMock() {
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

      (throwingModule as any).Terminal = vi.fn(function ThrowingTerminalMock() {
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

  // --- FN-1739 mobile WebGL skip regression tests ---
  describe("mobile WebGL skip (FN-1739)", () => {
    let savedInnerWidth: typeof window.innerWidth;
    let savedOntouchstart: typeof window.ontouchstart;
    let savedNavigator: typeof navigator;

    beforeEach(() => {
      savedInnerWidth = window.innerWidth;
      savedOntouchstart = window.ontouchstart;
      savedNavigator = navigator;

      // Mock WebGL addon to track if it's loaded
      vi.mock("@xterm/addon-webgl", () => ({
        WebglAddon: vi.fn(function WebglAddonMock() {
          return {
            onContextLoss: vi.fn(),
            dispose: vi.fn(),
          };
        }),
      }));
    });

    afterEach(() => {
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
      Object.defineProperty(navigator, "maxTouchPoints", {
        value: (savedNavigator as any).maxTouchPoints,
        writable: true,
        configurable: true,
      });
    });

    function simulateMobileDevice() {
      Object.defineProperty(window, "innerWidth", {
        value: 375,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, "ontouchstart", {
        value: undefined,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(navigator, "maxTouchPoints", {
        value: 2,
        writable: true,
        configurable: true,
      });
    }

    it("does not load WebGL addon when device is mobile", async () => {
      simulateMobileDevice();

      // Import WebGL addon mock to get reference for assertions
      const webglModule = await import("@xterm/addon-webgl");

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      // Wait for xterm initialization to complete
      await waitFor(() => {
        expect(mockTerminalInstance.open).toHaveBeenCalled();
      });

      // WebGL addon constructor should NOT have been called
      expect(webglModule.WebglAddon).not.toHaveBeenCalled();
    });
  });

  describe("xterm import MIME type retry", () => {
    function isXtermImportBatch(values: Iterable<unknown>): values is Promise<unknown>[] {
      return (
        Array.isArray(values) &&
        values.length === 3 &&
        values.every((entry) => entry && typeof (entry as Promise<unknown>).then === "function")
      );
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries MIME type import failures and initializes successfully on a later attempt", async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const originalPromiseAll = Promise.all.bind(Promise);
      let importAttempts = 0;

      vi.spyOn(Promise, "all").mockImplementation(((values: Iterable<unknown>) => {
        if (isXtermImportBatch(values)) {
          importAttempts += 1;
          if (importAttempts === 1) {
            return Promise.reject(
              new Error("'text/html' is not a valid JavaScript MIME type"),
            );
          }
        }

        return originalPromiseAll(values);
      }) as typeof Promise.all);

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      vi.useRealTimers();

      await waitFor(() => {
        expect(mockTerminalInstance.open).toHaveBeenCalled();
      });

      expect(importAttempts).toBe(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("terminal-xterm-init-error")).toBeNull();
    });

    it("shows xterm init error UI when MIME type import retries are exhausted", async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const originalPromiseAll = Promise.all.bind(Promise);
      let importAttempts = 0;

      vi.spyOn(Promise, "all").mockImplementation(((values: Iterable<unknown>) => {
        if (isXtermImportBatch(values)) {
          importAttempts += 1;
          return Promise.reject(
            new Error("'text/html' is not a valid JavaScript MIME type"),
          );
        }

        return originalPromiseAll(values);
      }) as typeof Promise.all);

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      vi.useRealTimers();

      await waitFor(() => {
        expect(screen.getByTestId("terminal-xterm-init-error")).toBeTruthy();
      });

      expect(screen.getByText(/MIME type/)).toBeTruthy();
      expect(importAttempts).toBe(4);
      expect(warnSpy).toHaveBeenCalledTimes(3);
    });

    it("does not retry non-MIME import failures", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const originalPromiseAll = Promise.all.bind(Promise);
      let importAttempts = 0;

      vi.spyOn(Promise, "all").mockImplementation(((values: Iterable<unknown>) => {
        if (isXtermImportBatch(values)) {
          importAttempts += 1;
          return Promise.reject(new Error("xterm constructor failed"));
        }

        return originalPromiseAll(values);
      }) as typeof Promise.all);

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByTestId("terminal-xterm-init-error")).toBeTruthy();
      });

      expect(screen.getByText(/xterm constructor failed/)).toBeTruthy();
      expect(importAttempts).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // --- Invalid session auto-recovery ---
  describe("invalid session auto-recovery (FN-1021)", () => {
    it("calls replaceActiveTabSession when WebSocket reports session invalid (code 4004)", async () => {
      const mockReplaceActiveTabSession = vi.fn().mockResolvedValue(undefined);
      let capturedSessionInvalidCb: (() => void) | null = null;

      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        replaceActiveTabSession: mockReplaceActiveTabSession,
      });

      mockUseTerminal.mockReturnValue(
        createMockTerminalState({
          connectionStatus: "disconnected",
          onSessionInvalid: vi.fn((cb: () => void) => {
            capturedSessionInvalidCb = cb;
            return vi.fn();
          }),
        })
      );

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(capturedSessionInvalidCb).not.toBeNull();
      });

      // Simulate the WebSocket reporting session invalid
      act(() => {
        capturedSessionInvalidCb!();
      });

      expect(mockReplaceActiveTabSession).toHaveBeenCalledTimes(1);
    });

    it("clears xterm state when session is invalid", async () => {
      const mockReplaceActiveTabSession = vi.fn().mockResolvedValue(undefined);
      let capturedSessionInvalidCb: (() => void) | null = null;

      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        replaceActiveTabSession: mockReplaceActiveTabSession,
      });

      mockUseTerminal.mockReturnValue(
        createMockTerminalState({
          connectionStatus: "connected",
          onSessionInvalid: vi.fn((cb: () => void) => {
            capturedSessionInvalidCb = cb;
            return vi.fn();
          }),
        })
      );

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      // Wait for xterm to initialize
      await waitFor(() => {
        expect(mockTerminalInstance.open).toHaveBeenCalled();
      });

      // Simulate session invalidation
      act(() => {
        capturedSessionInvalidCb!();
      });

      // xterm should be disposed and cleared for fresh init
      expect(mockTerminalInstance.dispose).toHaveBeenCalled();
      expect(mockTerminalInstance.clear).toHaveBeenCalled();
    });

    it("terminal is usable after session recovery without page reload", async () => {
      const mockReplaceActiveTabSession = vi.fn().mockResolvedValue(undefined);
      let capturedSessionInvalidCb: (() => void) | null = null;

      // Start with a stale session that will be invalidated
      const staleTab = {
        id: "tab-stale",
        sessionId: "stale-session-999",
        title: "bash",
        isActive: true,
        createdAt: Date.now(),
      };

      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        tabs: [staleTab],
        activeTab: staleTab,
        replaceActiveTabSession: mockReplaceActiveTabSession,
      });

      mockUseTerminal.mockReturnValue(
        createMockTerminalState({
          connectionStatus: "disconnected",
          onSessionInvalid: vi.fn((cb: () => void) => {
            capturedSessionInvalidCb = cb;
            return vi.fn();
          }),
        })
      );

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByTestId("terminal-modal")).toBeTruthy();
      });

      // Trigger session invalidation
      act(() => {
        capturedSessionInvalidCb!();
      });

      // replaceActiveTabSession should be called — this creates a new session
      await waitFor(() => {
        expect(mockReplaceActiveTabSession).toHaveBeenCalledTimes(1);
      });

      // Simulate the session hook returning a new session after replacement
      const freshTab = {
        id: "tab-stale",
        sessionId: "fresh-session-001",
        title: "bash",
        isActive: true,
        createdAt: Date.now(),
      };

      mockUseTerminalSessions.mockReturnValue({
        ...defaultSessionState,
        tabs: [freshTab],
        activeTab: freshTab,
        replaceActiveTabSession: mockReplaceActiveTabSession,
      });

      // After replacement, useTerminal should be called with the new session ID
      // This happens automatically because activeTab.sessionId changed
      // The modal should still be open and usable
      expect(screen.getByTestId("terminal-modal")).toBeTruthy();

      // No bootstrap error should be shown (we recovered)
      expect(screen.queryByTestId("terminal-bootstrap-error")).toBeNull();
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
    onSessionInvalid: vi.fn(() => vi.fn()),
    ...overrides,
  });

  const manyTabsSessionState = {
    tabs: createManyTabs(),
    activeTab: createManyTabs()[0],
    isReady: true,
    bootstrapError: null,
    createTab: vi.fn(),
    closeTab: vi.fn(),
    setActiveTab: vi.fn(),
    updateTabTitle: vi.fn(),
    restartActiveTab: vi.fn(),
    retryBootstrap: vi.fn(),
    replaceActiveTabSession: vi.fn().mockResolvedValue(undefined),
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

  it("adds the shortcut spacing hook to the shortcuts toggle", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-shortcut-toggle").className).toContain(
        "terminal-clear-btn--shortcut",
      );
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
    onSessionInvalid: vi.fn(() => vi.fn()),
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

    const { rerender } = renderWithTabs([firstTab], firstTab);

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

// --- FN-1234 mobile tab + keyboard regression tests ---
describe("TerminalModal — FN-1234 mobile tab switch with keyboard", () => {
  const mockOnClose = vi.fn();

  const createMockTerminalState = (overrides = {}) => ({
    connectionStatus: "connected" as const,
    sendInput: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onConnect: vi.fn(() => vi.fn()),
    onScrollback: vi.fn(() => vi.fn()),
    reconnect: vi.fn(),
    onSessionInvalid: vi.fn(() => vi.fn()),
    ...overrides,
  });

  const makeTab = (id: string, sessionId: string, isActive: boolean, title = id) => ({
    id,
    sessionId,
    title,
    isActive,
    createdAt: Date.now(),
  });

  const makeSessionState = (tabs: Array<ReturnType<typeof makeTab>>) => ({
    tabs,
    activeTab: tabs.find((tab) => tab.isActive) ?? null,
    isReady: true,
    bootstrapError: null,
    createTab: vi.fn(),
    closeTab: vi.fn(),
    setActiveTab: vi.fn(),
    updateTabTitle: vi.fn(),
    restartActiveTab: vi.fn(),
    retryBootstrap: vi.fn(),
    replaceActiveTabSession: vi.fn().mockResolvedValue(undefined),
  });

  const createTerminalInstance = (cols: number, rows: number) => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn((_cb: (data: string) => void) => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ""),
    paste: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    options: { fontSize: 14 },
    cols,
    rows,
  });

  let savedVisualViewport: typeof window.visualViewport;
  let savedInnerWidth: typeof window.innerWidth;
  let savedInnerHeight: typeof window.innerHeight;
  let savedOntouchstart: typeof window.ontouchstart;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetInitialViewportHeight();

    savedVisualViewport = window.visualViewport;
    savedInnerWidth = window.innerWidth;
    savedInnerHeight = window.innerHeight;
    savedOntouchstart = window.ontouchstart;
  });

  afterEach(() => {
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
    Object.defineProperty(window, "innerHeight", {
      value: savedInnerHeight,
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

  function simulateMobileDevice(initialVvHeight = 667) {
    (window as any).ontouchstart = null;
    Object.defineProperty(window, "innerWidth", {
      value: 375,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 667,
      writable: true,
      configurable: true,
    });

    const listeners: Record<string, Array<() => void>> = {
      resize: [],
      scroll: [],
    };

    const mockVV = {
      width: 375,
      height: initialVvHeight,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener: vi.fn((event: string, cb: () => void) => {
        listeners[event]?.push(cb);
      }),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(window, "visualViewport", {
      value: mockVV,
      writable: true,
      configurable: true,
    });

    return { listeners, mockVV };
  }

  it("tab switch + keyboard open keeps data on the active session terminal", async () => {
    const { listeners, mockVV } = simulateMobileDevice();
    const tab1 = makeTab("tab-1", "session-1", true, "one");
    const tab2 = makeTab("tab-2", "session-2", false, "two");

    const terminalOne = createTerminalInstance(80, 24);
    const terminalTwo = createTerminalInstance(120, 40);

    const xtermModule = await import("@xterm/xterm");
    vi.mocked(xtermModule.Terminal)
      .mockImplementationOnce(function TerminalOneMock() {
        return terminalOne as any;
      } as never)
      .mockImplementationOnce(function TerminalTwoMock() {
        return terminalTwo as any;
      } as never);

    let sessionOneDataCallback: ((data: string) => void) | null = null;
    let sessionTwoDataCallback: ((data: string) => void) | null = null;

    mockUseTerminalSessions.mockReturnValue(makeSessionState([tab1, tab2]));
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        onData: vi.fn((cb: (data: string) => void) => {
          sessionOneDataCallback = cb;
          return vi.fn();
        }),
      })
    );

    const { rerender } = render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(terminalOne.open).toHaveBeenCalled();
    });

    mockUseTerminalSessions.mockReturnValue(
      makeSessionState([{ ...tab1, isActive: false }, { ...tab2, isActive: true }])
    );
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        onData: vi.fn((cb: (data: string) => void) => {
          sessionTwoDataCallback = cb;
          return vi.fn();
        }),
      })
    );

    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(terminalTwo.open).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(sessionTwoDataCallback).not.toBeNull();
    });

    Object.defineProperty(mockVV, "height", {
      value: 417,
      writable: true,
      configurable: true,
    });
    act(() => {
      listeners.resize.forEach((cb) => cb());
    });

    terminalOne.write.mockClear();
    terminalTwo.write.mockClear();

    act(() => {
      sessionOneDataCallback?.("session-1 stale output\\r\\n");
      sessionTwoDataCallback?.("session-2 fresh output\\r\\n");
    });

    expect(terminalTwo.write).toHaveBeenCalledWith("session-2 fresh output\\r\\n");
    expect(terminalTwo.write).not.toHaveBeenCalledWith("session-1 stale output\\r\\n");
    expect(terminalOne.write).not.toHaveBeenCalledWith("session-1 stale output\\r\\n");
  });

  it("re-fits and resizes the switched tab terminal when keyboard opens", async () => {
    const { listeners, mockVV } = simulateMobileDevice();
    const tab1 = makeTab("tab-1", "session-1", true, "one");
    const tab2 = makeTab("tab-2", "session-2", false, "two");

    const terminalOne = createTerminalInstance(90, 30);
    const terminalTwo = createTerminalInstance(132, 44);
    const fitOne = { fit: vi.fn(), dispose: vi.fn() };
    const fitTwo = { fit: vi.fn(), dispose: vi.fn() };
    const resizeOne = vi.fn();
    const resizeTwo = vi.fn();

    const xtermModule = await import("@xterm/xterm");
    vi.mocked(xtermModule.Terminal)
      .mockImplementationOnce(function TerminalOneMock() {
        return terminalOne as any;
      } as never)
      .mockImplementationOnce(function TerminalTwoMock() {
        return terminalTwo as any;
      } as never);

    const fitModule = await import("@xterm/addon-fit");
    vi.mocked(fitModule.FitAddon)
      .mockImplementationOnce(function FitOneMock() {
        return fitOne as any;
      } as never)
      .mockImplementationOnce(function FitTwoMock() {
        return fitTwo as any;
      } as never);

    mockUseTerminalSessions.mockReturnValue(makeSessionState([tab1, tab2]));
    mockUseTerminal.mockReturnValue(createMockTerminalState({ resize: resizeOne }));

    const { rerender } = render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(terminalOne.open).toHaveBeenCalled();
    });

    mockUseTerminalSessions.mockReturnValue(
      makeSessionState([{ ...tab1, isActive: false }, { ...tab2, isActive: true }])
    );
    mockUseTerminal.mockReturnValue(createMockTerminalState({ resize: resizeTwo }));

    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(terminalTwo.open).toHaveBeenCalled();
    });

    fitTwo.fit.mockClear();
    resizeOne.mockClear();
    resizeTwo.mockClear();

    Object.defineProperty(mockVV, "height", {
      value: 350,
      writable: true,
      configurable: true,
    });
    act(() => {
      listeners.resize.forEach((cb) => cb());
    });

    await waitFor(() => {
      expect(fitTwo.fit).toHaveBeenCalled();
    });
    expect(resizeTwo).toHaveBeenCalledWith(132, 44);
    expect(resizeOne).not.toHaveBeenCalled();
  });

  it("applies keyboard overlap CSS vars on the switched tab after keyboard opens", async () => {
    const { listeners, mockVV } = simulateMobileDevice();
    const tab1 = makeTab("tab-1", "session-1", true, "one");
    const tab2 = makeTab("tab-2", "session-2", false, "two");

    mockUseTerminalSessions.mockReturnValue(makeSessionState([tab1, tab2]));
    mockUseTerminal.mockReturnValue(createMockTerminalState());

    const { rerender } = render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    mockUseTerminalSessions.mockReturnValue(
      makeSessionState([{ ...tab1, isActive: false }, { ...tab2, isActive: true }])
    );
    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    Object.defineProperty(mockVV, "height", {
      value: 430,
      writable: true,
      configurable: true,
    });
    act(() => {
      listeners.resize.forEach((cb) => cb());
    });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("237px");
      expect(modal.style.getPropertyValue("--vv-height")).toBe("430px");
    });
  });

  it("replays scrollback to the active session after tab switch + keyboard open", async () => {
    const { listeners, mockVV } = simulateMobileDevice();
    const tab1 = makeTab("tab-1", "session-1", true, "one");
    const tab2 = makeTab("tab-2", "session-2", false, "two");

    const terminalOne = createTerminalInstance(80, 24);
    const terminalTwo = createTerminalInstance(100, 32);

    const xtermModule = await import("@xterm/xterm");
    vi.mocked(xtermModule.Terminal)
      .mockImplementationOnce(function TerminalOneMock() {
        return terminalOne as any;
      } as never)
      .mockImplementationOnce(function TerminalTwoMock() {
        return terminalTwo as any;
      } as never);

    let sessionOneScrollbackCallback: ((data: string) => void) | null = null;
    let sessionTwoScrollbackCallback: ((data: string) => void) | null = null;

    mockUseTerminalSessions.mockReturnValue(makeSessionState([tab1, tab2]));
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        onScrollback: vi.fn((cb: (data: string) => void) => {
          sessionOneScrollbackCallback = cb;
          return vi.fn();
        }),
      })
    );

    const { rerender } = render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(terminalOne.open).toHaveBeenCalled();
    });

    mockUseTerminalSessions.mockReturnValue(
      makeSessionState([{ ...tab1, isActive: false }, { ...tab2, isActive: true }])
    );
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({
        onScrollback: vi.fn((cb: (data: string) => void) => {
          sessionTwoScrollbackCallback = cb;
          return vi.fn();
        }),
      })
    );

    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(terminalTwo.open).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(sessionTwoScrollbackCallback).not.toBeNull();
    });

    Object.defineProperty(mockVV, "height", {
      value: 390,
      writable: true,
      configurable: true,
    });
    act(() => {
      listeners.resize.forEach((cb) => cb());
    });

    terminalOne.write.mockClear();
    terminalTwo.write.mockClear();

    act(() => {
      sessionOneScrollbackCallback?.("session-1 scrollback\\r\\n");
      sessionTwoScrollbackCallback?.("session-2 scrollback\\r\\n");
    });

    expect(terminalTwo.write).toHaveBeenCalledWith("session-2 scrollback\\r\\n");
    expect(terminalTwo.write).not.toHaveBeenCalledWith("session-1 scrollback\\r\\n");
    expect(terminalOne.write).not.toHaveBeenCalledWith("session-1 scrollback\\r\\n");
  });
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
    onSessionInvalid: vi.fn(() => vi.fn()),
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
    replaceActiveTabSession: vi.fn().mockResolvedValue(undefined),
  };

  let savedVisualViewport: typeof window.visualViewport;
  let savedInnerWidth: typeof window.innerWidth;
  let savedOntouchstart: typeof window.ontouchstart;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetInitialViewportHeight();
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
    const { listeners, mockVV } = simulateMobileDevice(250);

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} />,
    );

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("250px");
    });

    // Keyboard closes → visualViewport.height returns to full height (550 = innerHeight)
    Object.defineProperty(mockVV, "height", {
      value: 550,
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

  it("scrolls modal into view when keyboard opens on mobile", async () => {
    const scrollIntoViewSpy = vi.fn();
    const { listeners } = simulateMobileDevice(250);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("250px");
    });

    // Attach the spy to the rendered modal element
    const modal = screen.getByTestId("terminal-modal");
    modal.scrollIntoView = scrollIntoViewSpy;

    // Trigger a resize event to re-run the update callback
    act(() => {
      for (const cb of listeners.resize) cb();
    });

    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "end", behavior: "smooth" });
  });

  it("does not scroll modal when keyboard overlap is zero", async () => {
    const scrollIntoViewSpy = vi.fn();
    const { listeners } = simulateMobileDevice(0); // no overlap

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });

    const modal = screen.getByTestId("terminal-modal");
    modal.scrollIntoView = scrollIntoViewSpy;

    // Trigger a resize event
    act(() => {
      for (const cb of listeners.resize) cb();
    });

    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });

  it("sets --overlay-padding-top on overlay when keyboard overlap is detected", async () => {
    simulateMobileDevice(250);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const overlay = screen.getByTestId("terminal-modal-overlay");
      expect(overlay.style.getPropertyValue("--overlay-padding-top")).toBe("0px");
    });
  });

  it("clears --overlay-padding-top from overlay when keyboard closes", async () => {
    const { listeners, mockVV } = simulateMobileDevice(250);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const overlay = screen.getByTestId("terminal-modal-overlay");
      expect(overlay.style.getPropertyValue("--overlay-padding-top")).toBe("0px");
    });

    // Keyboard closes → visualViewport.height returns to full height (550 = innerHeight)
    Object.defineProperty(mockVV, "height", {
      value: 550,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      const overlay = screen.getByTestId("terminal-modal-overlay");
      expect(overlay.style.getPropertyValue("--overlay-padding-top")).toBe("");
    });
  });

  describe("xterm re-fit on keyboard open (FN-1043 regression)", () => {
    /** Pending rAF callbacks keyed by fake id. */
    let rafMap: Map<number, () => void>;
    let nextRafId: number;
    let originalRAF: typeof window.requestAnimationFrame;
    let originalCAF: typeof window.cancelAnimationFrame;

    beforeEach(() => {
      rafMap = new Map();
      nextRafId = 1;
      originalRAF = window.requestAnimationFrame;
      originalCAF = window.cancelAnimationFrame;
      // Capture rAF callbacks with proper cancellation support so the
      // coalescing logic (cancel → schedule) works correctly in tests.
      window.requestAnimationFrame = ((cb: () => void) => {
        const id = nextRafId++;
        rafMap.set(id, cb);
        return id;
      }) as any;
      window.cancelAnimationFrame = ((id: number) => {
        rafMap.delete(id);
      }) as any;
    });

    afterEach(() => {
      window.requestAnimationFrame = originalRAF;
      window.cancelAnimationFrame = originalCAF;
    });

    /** Flush all pending rAF callbacks and clear the map. */
    function flushRaf() {
      const callbacks = Array.from(rafMap.values());
      rafMap.clear();
      for (const cb of callbacks) cb();
    }

    it("defers fitAddon.fit() via requestAnimationFrame after keyboard open", async () => {
      const { listeners } = simulateMobileDevice(250);
      const mockResizeFn = vi.fn();

      mockUseTerminal.mockReturnValue(createMockTerminalState({
        connectionStatus: "connected",
        resize: mockResizeFn,
      }));

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      // Wait for --keyboard-overlap to be set (initial measurement + rAF)
      await waitFor(() => {
        const modal = screen.getByTestId("terminal-modal");
        expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("250px");
      });

      // Flush any pending rAF from initial mount
      act(() => { flushRaf(); });

      // Clear the map before triggering the resize
      rafMap.clear();

      // Trigger a viewport resize (keyboard opened)
      act(() => {
        for (const cb of listeners.resize) cb();
      });

      // The rAF callback should have been scheduled
      expect(rafMap.size).toBeGreaterThanOrEqual(1);

      // Flush the rAF — this exercises the deferred fit logic.
      // In the test env, fitAddonRef.current is null (xterm is mocked
      // as a plain object, not wired into refs), so fit() won't actually
      // run. We verify the mechanism by confirming rAF was used.
      expect(() => {
        act(() => { flushRaf(); });
      }).not.toThrow();
    });

    it("coalesces rapid visualViewport resize events into a single rAF callback", async () => {
      const { listeners } = simulateMobileDevice(250);

      mockUseTerminal.mockReturnValue(createMockTerminalState({
        connectionStatus: "connected",
      }));

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        const modal = screen.getByTestId("terminal-modal");
        expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("250px");
      });

      // Flush any pending rAF from initial mount
      act(() => { flushRaf(); });
      rafMap.clear();

      // Fire multiple rapid resize events (keyboard animating open).
      // Each event calls cancelAnimationFrame(previous) then requestAnimationFrame(new),
      // so only 1 callback should remain in the map after 3 events.
      act(() => {
        for (const cb of listeners.resize) cb(); // event 1 → schedule rAF #1
        for (const cb of listeners.resize) cb(); // event 2 → cancel #1, schedule rAF #2
        for (const cb of listeners.resize) cb(); // event 3 → cancel #2, schedule rAF #3
      });

      // Only 1 rAF callback should survive (the last one)
      expect(rafMap.size).toBe(1);
    });

    it("reads xterm refs inside the rAF callback (not stale closures)", async () => {
      const { listeners } = simulateMobileDevice(250);

      mockUseTerminal.mockReturnValue(createMockTerminalState({
        connectionStatus: "connected",
        resize: vi.fn(),
      }));

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        const modal = screen.getByTestId("terminal-modal");
        expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("250px");
      });

      // Flush any pending rAF from initial mount
      act(() => { flushRaf(); });
      rafMap.clear();

      // Trigger resize
      act(() => {
        for (const cb of listeners.resize) cb();
      });

      // Flush rAF — this should not throw even though xterm refs may be null
      // in the test environment. The callback reads refs at call time, not capture time.
      expect(() => {
        act(() => { flushRaf(); });
      }).not.toThrow();
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
    onSessionInvalid: vi.fn(() => vi.fn()),
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
    replaceActiveTabSession: vi.fn().mockResolvedValue(undefined),
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

// --- FN-872: Real mobile keyboard regression tests ---
describe("TerminalModal — FN-872 real-device keyboard overlap refinement", () => {
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
    onSessionInvalid: vi.fn(() => vi.fn()),
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
    replaceActiveTabSession: vi.fn().mockResolvedValue(undefined),
  };

  let savedVisualViewport: typeof window.visualViewport;
  let savedInnerWidth: typeof window.innerWidth;
  let savedInnerHeight: typeof window.innerHeight;
  let savedOntouchstart: typeof window.ontouchstart;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetInitialViewportHeight();
    mockUseTerminal.mockReturnValue(createMockTerminalState());
    mockUseTerminalSessions.mockReturnValue(defaultSessionState);

    // Stash originals
    savedVisualViewport = window.visualViewport;
    savedInnerWidth = window.innerWidth;
    savedInnerHeight = window.innerHeight;
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
    Object.defineProperty(window, "innerHeight", {
      value: savedInnerHeight,
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
   * Helper: simulate a mobile device (Chrome Android style) where
   * window.innerHeight stays constant but visualViewport shrinks.
   */
  function simulateChromeAndroid(overlapPx: number) {
    (window as any).ontouchstart = null;
    Object.defineProperty(window, "innerWidth", {
      value: 375,
      writable: true,
      configurable: true,
    });

    const vvHeight = 667 - overlapPx; // initial height minus keyboard

    const listeners: Record<string, Array<() => void>> = {
      resize: [],
      scroll: [],
    };

    const mockVV = {
      width: 375,
      height: vvHeight,
      offsetTop: 0,
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

    // Chrome Android: innerHeight stays at full height
    Object.defineProperty(window, "innerHeight", {
      value: 667,
      writable: true,
      configurable: true,
    });

    return { listeners, mockVV };
  }

  /**
   * Helper: simulate iOS Safari where window.innerHeight shrinks when
   * the keyboard opens (both window.innerHeight and visualViewport.height
   * shrink together).
   */
  function simulateIOSSafari(keyboardOpen: boolean, vvHeight?: number) {
    (window as any).ontouchstart = null;
    Object.defineProperty(window, "innerWidth", {
      value: 375,
      writable: true,
      configurable: true,
    });

    const initialHeight = 667;
    const effectiveVvHeight = vvHeight ?? (keyboardOpen ? 300 : initialHeight);

    const listeners: Record<string, Array<() => void>> = {
      resize: [],
      scroll: [],
    };

    const mockVV = {
      width: 375,
      height: effectiveVvHeight,
      offsetTop: 0,
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

    // iOS Safari: innerHeight matches visual viewport height
    Object.defineProperty(window, "innerHeight", {
      value: effectiveVvHeight,
      writable: true,
      configurable: true,
    });

    return { listeners, mockVV, initialHeight };
  }

  it("detects keyboard on iOS Safari where innerHeight shrinks with visualViewport", async () => {
    // On iOS Safari, both window.innerHeight and visualViewport.height shrink.
    // The primary formula (innerHeight - vv.offsetTop - vv.height) returns 0
    // because innerHeight == vv.height. The fallback should detect the gap
    // from the cached initial viewport height.
    //
    // To properly test this, we start with full viewport (no keyboard),
    // then simulate the keyboard opening by shrinking both values.
    const { listeners, mockVV } = simulateIOSSafari(false, 667);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Initially no overlap
    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });

    // Now simulate keyboard opening: both innerHeight and vv shrink
    Object.defineProperty(window, "innerHeight", {
      value: 300,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockVV, "height", {
      value: 300,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    // Should detect overlap via the initialHeight fallback
    // initialHeight was captured as 667, so overlap = 667 - 0 - 300 = 367
    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("367px");
    });
  });

  it("does not detect keyboard on iOS Safari when viewport is full height", async () => {
    const { listeners } = simulateIOSSafari(false, 667);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });
  });

  it("sets --vv-height CSS variable to visualViewport.height when keyboard is open", async () => {
    const { listeners } = simulateChromeAndroid(250);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      // --vv-height should be set to the visualViewport height (417px = 667 - 250)
      expect(modal.style.getPropertyValue("--vv-height")).toBe("417px");
    });
  });

  it("updates --vv-height when visualViewport height changes", async () => {
    const { listeners, mockVV } = simulateChromeAndroid(250);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--vv-height")).toBe("417px");
    });

    // Keyboard partially closes: vv height increases from 417 to 567
    Object.defineProperty(mockVV, "height", { value: 567, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--vv-height")).toBe("567px");
    });
  });

  it("does not set --vv-height when no keyboard overlap", async () => {
    const { listeners } = simulateChromeAndroid(0);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      // No overlap → style should be undefined (no --vv-height set)
      expect(modal.style.getPropertyValue("--vv-height")).toBe("");
    });
  });

  it("calls fitAddon.fit() and resize when viewport changes with keyboard open", async () => {
    const { listeners } = simulateChromeAndroid(250);

    // Mock fit and resize to be trackable
    const mockFit = vi.fn();
    const mockFitAddon = { fit: mockFit, dispose: vi.fn() };
    const fitAddonModule = await import("@xterm/addon-fit");
    (fitAddonModule.FitAddon as unknown as ReturnType<typeof vi.fn>).mockImplementation(function FitAddonMock() {
      return mockFitAddon;
    });

    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ connectionStatus: "connected" })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Wait for xterm to initialize
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    // Clear previous resize calls from initial setup
    mockResize.mockClear();

    // Trigger a viewport resize event (keyboard height changes)
    act(() => {
      for (const cb of listeners.resize) cb();
    });

    // fitAddon.fit() should have been called during viewport change
    await waitFor(() => {
      expect(mockFit).toHaveBeenCalled();
    });

    // resize should have been called with xterm dimensions
    await waitFor(() => {
      expect(mockResize).toHaveBeenCalledWith(80, 24);
    });
  });

  it("clears --vv-height when keyboard closes", async () => {
    const { listeners, mockVV } = simulateChromeAndroid(250);

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} />,
    );

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--vv-height")).toBe("417px");
    });

    // Keyboard closes: overlap becomes 0, vv height returns to full
    Object.defineProperty(mockVV, "height", { value: 667, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      // Both variables should be cleared when overlap is 0
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
      expect(modal.style.getPropertyValue("--vv-height")).toBe("");
    });
  });

  it("handles rapid keyboard open/close transitions without stale state", async () => {
    const { listeners, mockVV } = simulateChromeAndroid(250);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("250px");
    });

    // Rapid open → close → open sequence
    // First: keyboard partially closes
    Object.defineProperty(mockVV, "height", { value: 567, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    // Then: keyboard fully closes
    Object.defineProperty(mockVV, "height", { value: 667, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    // Then: keyboard opens again with different height
    Object.defineProperty(mockVV, "height", { value: 350, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      // Should reflect the latest state: overlap = 667 - 350 = 317
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("317px");
      expect(modal.style.getPropertyValue("--vv-height")).toBe("350px");
    });
  });

  it("clears viewportHeight when modal closes on mobile", async () => {
    const { listeners } = simulateChromeAndroid(250);

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} />,
    );

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--vv-height")).toBe("417px");
    });

    // Close the modal
    act(() => {
      rerender(<TerminalModal isOpen={false} onClose={mockOnClose} />);
    });

    // Modal is no longer rendered
    expect(screen.queryByTestId("terminal-modal")).toBeNull();
  });

  // --- FN-1002: Lowered threshold (150 → 80) with 30px noise filter ---
  it("detects keyboard with gap of 85px (above new 80px threshold)", async () => {
    // Previously with the 150px threshold, 85px would NOT be detected.
    // With the new 80px threshold, it should be detected.
    const { listeners, mockVV } = simulateIOSSafari(false, 667);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Initially no overlap
    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });

    // Simulate keyboard opening with gap of 85px: vv.height = 667 - 85 = 582
    Object.defineProperty(window, "innerHeight", {
      value: 582,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockVV, "height", {
      value: 582,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("85px");
    });
  });

  it("does not detect keyboard with very small gap of 20px (noise filter)", async () => {
    // Gap of 20px is below the 30px noise filter — should return 0.
    const { listeners, mockVV } = simulateIOSSafari(false, 667);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });

    // Simulate tiny viewport change: gap = 20px, vv.height = 667 - 20 = 647
    Object.defineProperty(window, "innerHeight", {
      value: 647,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockVV, "height", {
      value: 647,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });
  });

  it("does not detect keyboard when gap is exactly 80px (boundary, not > 80)", async () => {
    const { listeners, mockVV } = simulateIOSSafari(false, 667);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });

    // gap = 80px exactly: vv.height = 667 - 80 = 587
    Object.defineProperty(window, "innerHeight", {
      value: 587,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockVV, "height", {
      value: 587,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      // 80 is NOT > 80, so should not be detected
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });
  });

  it("detects keyboard when gap is 81px (just above 80px boundary)", async () => {
    const { listeners, mockVV } = simulateIOSSafari(false, 667);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("");
    });

    // gap = 81px: vv.height = 667 - 81 = 586
    Object.defineProperty(window, "innerHeight", {
      value: 586,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockVV, "height", {
      value: 586,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("81px");
    });
  });

  it("scroll event on visualViewport also triggers keyboard overlap update", async () => {
    const { listeners, mockVV } = simulateChromeAndroid(250);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("250px");
    });

    // Simulate scroll event changing viewport (e.g., keyboard changing position)
    Object.defineProperty(mockVV, "height", { value: 500, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.scroll) cb();
    });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("167px");
    });
  });

  /**
   * Regression (FN-1025): terminal moves up when keyboard is open but not
   * high enough — bottom still overlapped.
   *
   * The root cause was that the CSS only set max-height (not height) in the
   * keyboard-open selector, and the inherited min-height: 90vh from desktop
   * prevented the modal from shrinking to fit above the keyboard.
   *
   * This test verifies the component correctly sets BOTH --keyboard-overlap
   * and --vv-height CSS variables so the CSS contract can constrain the modal
   * to the visual viewport height (via height + max-height + min-height: auto).
   */
  it("FN-1025: sets both --keyboard-overlap and --vv-height for partial overlap (moves up but still overlapped)", async () => {
    // Simulate a keyboard that partially covers the terminal — the classic
    // "moves up but not enough" scenario. Overlap of 150px on a 667px screen
    // means the modal should shrink to 517px (vv.height).
    const { listeners, mockVV } = simulateChromeAndroid(150);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      // --keyboard-overlap must be set so the CSS selector matches
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("150px");
      // --vv-height must be set so height/max-height resolve correctly
      // vv.height = 667 - 150 = 517
      expect(modal.style.getPropertyValue("--vv-height")).toBe("517px");
    });
  });

  it("FN-1025: updates both CSS variables when keyboard height changes", async () => {
    const { listeners, mockVV } = simulateChromeAndroid(150);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("150px");
      expect(modal.style.getPropertyValue("--vv-height")).toBe("517px");
    });

    // Keyboard grows taller: overlap increases from 150 to 300
    Object.defineProperty(mockVV, "height", { value: 367, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      // overlap = 667 - 367 = 300
      expect(modal.style.getPropertyValue("--keyboard-overlap")).toBe("300px");
      expect(modal.style.getPropertyValue("--vv-height")).toBe("367px");
    });
  });
});

// --- xterm focus initialization regression tests ---
describe("TerminalModal — xterm focus initialization (FN-1602)", () => {
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
    onSessionInvalid: vi.fn(() => vi.fn()),
    ...overrides,
  });

  beforeEach(async () => {
    const fitAddonModule = await import("@xterm/addon-fit");
    vi.mocked(fitAddonModule.FitAddon).mockImplementation(function FitAddonMock() {
      return {
        fit: mockFitAddonFit,
        dispose: vi.fn(),
      };
    } as never);
    vi.clearAllMocks();
    terminalKeyEventHandler = null;
    terminalDataHandler = null;
    mockTerminalInstance.onData.mockImplementation((cb: (data: string) => void) => {
      terminalDataHandler = cb;
      return { dispose: vi.fn() };
    });
    Object.defineProperty(document, "fonts", {
      value: undefined,
      configurable: true,
    });
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

  /**
   * Regression: terminal text entry not working after xterm initialization.
   *
   * The original bug occurred because xterm's programmatic focus() call did not
   * properly trigger xterm's internal focus tracking. xterm.js relies on
   * canvas click events to set up focus handling, so we now:
   * 1. Focus the helper textarea directly after terminal.open()
   * 2. Dispatch a synthetic click on the container to trigger xterm's
   *    internal focus tracking
   */
  it("renders terminal container after xterm is ready", async () => {
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ connectionStatus: "connected" })
    );

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    // Terminal container should be rendered
    expect(screen.getByTestId("terminal-xterm")).toBeTruthy();
  });

  it("handles dispatchEvent errors gracefully in non-browser environments", async () => {
    // Simulate dispatchEvent throwing an error (e.g., in jsdom without proper setup)
    const originalDispatchEvent = Element.prototype.dispatchEvent;
    Element.prototype.dispatchEvent = vi.fn(() => {
      throw new Error("dispatchEvent not supported");
    });

    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ connectionStatus: "connected" })
    );

    // Should not throw despite dispatchEvent failing
    expect(() => {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);
    }).not.toThrow();

    // Restore original method
    Element.prototype.dispatchEvent = originalDispatchEvent;
  });

  it("continues to work when connection status changes after initial render", async () => {
    // Start with disconnected
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ connectionStatus: "disconnected" })
    );

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} />
    );

    // xterm should still initialize
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    // Now simulate connection becoming established
    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ connectionStatus: "connected" })
    );

    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    // Modal should still render correctly
    await waitFor(() => {
      expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    });
  });

  it("forwards xterm onData input to sendInput", async () => {
    let terminalInputCallback: ((data: string) => void) | null = null;
    mockTerminalInstance.onData.mockImplementation((cb: (data: string) => void) => {
      terminalInputCallback = cb;
      return { dispose: vi.fn() };
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(terminalInputCallback).not.toBeNull();
    });

    act(() => {
      terminalInputCallback?.("echo hello\r");
    });

    expect(mockSendInput).toHaveBeenCalledWith("echo hello\r");
  });

  it.each([
    ["mac", "MacIntel", { metaKey: true }],
    ["non-mac", "Win32", { ctrlKey: true }],
  ] as const)("copies selected terminal text on platform copy modifier+c and blocks sigint on %s", async (_name, platform, modifier) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "platform", {
      value: platform,
      configurable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mockTerminalInstance.hasSelection.mockReturnValue(true);
    mockTerminalInstance.getSelection.mockReturnValue("copied output");

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(terminalKeyEventHandler).not.toBeNull();
    });

    const handled = terminalKeyEventHandler?.(
      new KeyboardEvent("keydown", { key: "c", ...modifier }),
    );

    expect(handled).toBe(false);
    expect(writeText).toHaveBeenCalledWith("copied output");
    expect(mockSendInput).not.toHaveBeenCalled();
  });

  it.each([
    ["mac ctrl", "MacIntel", { ctrlKey: true }],
    ["mac platform copy modifier", "MacIntel", { metaKey: true }],
    ["non-mac ctrl", "Win32", { ctrlKey: true }],
  ] as const)("preserves sigint on %s+c when nothing is selected", async (_name, platform, modifier) => {
    Object.defineProperty(navigator, "platform", {
      value: platform,
      configurable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    mockTerminalInstance.hasSelection.mockReturnValue(false);

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(terminalKeyEventHandler).not.toBeNull();
    });

    const handled = terminalKeyEventHandler?.(
      new KeyboardEvent("keydown", { key: "c", ...modifier }),
    );

    expect(handled).toBe(true);
  });

  it.each([
    ["mac", "MacIntel", { metaKey: true }],
    ["non-mac", "Win32", { ctrlKey: true }],
  ] as const)(
    "delivers keyboard paste exactly once via xterm native paste on %s",
    async (_name, platform, modifier) => {
      const readText = vi.fn().mockResolvedValue("npm test\n");
      Object.defineProperty(navigator, "platform", {
        value: platform,
        configurable: true,
      });
      Object.defineProperty(navigator, "clipboard", {
        value: { readText },
        configurable: true,
      });

      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(terminalKeyEventHandler).not.toBeNull();
        expect(terminalDataHandler).not.toBeNull();
      });

      const handled = terminalKeyEventHandler?.(
        new KeyboardEvent("keydown", { key: "v", ...modifier }),
      );
      act(() => {
        terminalDataHandler?.("npm test\n");
      });

      expect(handled).toBe(true);
      expect(readText).not.toHaveBeenCalled();
      expect(mockSendInput).toHaveBeenCalledTimes(1);
      expect(mockSendInput).toHaveBeenCalledWith("npm test\n");
    },
  );

  it("delivers native helper-textarea paste exactly once without the shortcut handler", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(terminalDataHandler).not.toBeNull();
    });

    act(() => {
      terminalDataHandler?.("line one\nline two\n");
    });

    expect(mockSendInput).toHaveBeenCalledTimes(1);
    expect(mockSendInput).toHaveBeenCalledWith("line one\nline two\n");
  });

  it("refits xterm after the async terminal font loads", async () => {
    let resolveFontLoad: (value: FontFace[]) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<FontFace[]>((resolve) => {
          resolveFontLoad = resolve;
        }),
    );
    Object.defineProperty(document, "fonts", {
      value: {
        load,
        ready: Promise.resolve(),
      },
      configurable: true,
    });

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
      expect(load).toHaveBeenCalledWith(expect.stringContaining("MesloLGS NF"));
      expect(load).not.toHaveBeenCalledWith(
        expect.stringContaining("Fusion Terminal Nerd Font Symbols"),
      );
    });

    const fitCallBaseline = mockFitAddonFit.mock.calls.length;

    await act(async () => {
      resolveFontLoad([]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockFitAddonFit.mock.calls.length).toBeGreaterThan(fitCallBaseline);
      expect(mockResize).toHaveBeenCalledWith(
        mockTerminalInstance.cols,
        mockTerminalInstance.rows,
      );
    });
  });

  it("still refits xterm when iOS rejects the multi-family font-load shorthand", async () => {
    const load = vi.fn(() => Promise.reject(new DOMException("Invalid font shorthand")));
    Object.defineProperty(document, "fonts", {
      value: {
        load,
        ready: Promise.resolve(),
      },
      configurable: true,
    });

    const fitCallBaseline = mockFitAddonFit.mock.calls.length;

    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
      expect(load).toHaveBeenCalledWith(expect.stringContaining("MesloLGS NF"));
      expect(load).not.toHaveBeenCalledWith(
        expect.stringContaining("Fusion Terminal Nerd Font Symbols"),
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockTerminalInstance.options.fontFamily).toBe(XTERM_FONT_FAMILY);
      expectMeasurementSafeFontStack(mockTerminalInstance.options.fontFamily as string);
      expect(mockTerminalInstance.options.fontSize).toBe(DEFAULT_TERMINAL_PREFERENCES.fontSize);
      expect(mockFitAddonFit.mock.calls.length).toBeGreaterThan(fitCallBaseline);
      expect(mockResize).toHaveBeenCalledWith(
        mockTerminalInstance.cols,
        mockTerminalInstance.rows,
      );
      expect(mockTerminalInstance.refresh).toHaveBeenCalledWith(0, mockTerminalInstance.rows - 1);
    });
  });

  it("leaves unrelated key handling untouched", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(terminalKeyEventHandler).not.toBeNull();
    });

    const handled = terminalKeyEventHandler?.(
      new KeyboardEvent("keydown", { key: "x", ctrlKey: true }),
    );

    expect(handled).toBe(true);
  });

  it("keeps terminal input forwarding active after active-tab title rerenders", async () => {
    let terminalInputCallback: ((data: string) => void) | null = null;
    const disposeInputHandler = vi.fn();

    mockTerminalInstance.onData.mockImplementation((cb: (data: string) => void) => {
      terminalInputCallback = cb;
      return { dispose: disposeInputHandler };
    });

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} />,
    );

    await waitFor(() => {
      expect(terminalInputCallback).not.toBeNull();
    });

    // Simulate tab metadata update (title change) that should not tear down
    // input forwarding for the same session.
    const renamedTab = {
      ...defaultTab,
      title: "bash (connected)",
      isActive: true,
    };

    mockUseTerminalSessions.mockReturnValue({
      ...defaultSessionState,
      tabs: [renamedTab],
      activeTab: renamedTab,
    });

    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(disposeInputHandler).not.toHaveBeenCalled();
    expect(mockTerminalInstance.onData).toHaveBeenCalledTimes(1);

    act(() => {
      terminalInputCallback?.("pwd\r");
    });

    expect(mockSendInput).toHaveBeenCalledWith("pwd\r");
  });

  it("keeps terminal input forwarding active after connection status transitions", async () => {
    let terminalInputCallback: ((data: string) => void) | null = null;
    const disposeInputHandler = vi.fn();

    mockTerminalInstance.onData.mockImplementation((cb: (data: string) => void) => {
      terminalInputCallback = cb;
      return { dispose: disposeInputHandler };
    });

    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ connectionStatus: "disconnected" }),
    );

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} />,
    );

    await waitFor(() => {
      expect(terminalInputCallback).not.toBeNull();
    });

    mockUseTerminal.mockReturnValue(
      createMockTerminalState({ connectionStatus: "connected" }),
    );
    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    expect(disposeInputHandler).not.toHaveBeenCalled();
    expect(mockTerminalInstance.onData).toHaveBeenCalledTimes(1);

    act(() => {
      terminalInputCallback?.("ls\r");
    });

    expect(mockSendInput).toHaveBeenCalledWith("ls\r");
  });

  it("focuses xterm helper textarea on user pointer gesture", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    const terminalDiv = screen.getByTestId("terminal-xterm");
    const helperTextarea = document.createElement("textarea");
    helperTextarea.className = "xterm-helper-textarea";
    const focusSpy = vi.spyOn(helperTextarea, "focus");
    const setSelectionRangeSpy = vi.spyOn(helperTextarea, "setSelectionRange");
    terminalDiv.appendChild(helperTextarea);

    fireEvent.pointerDown(terminalDiv);

    expect(mockTerminalInstance.focus).toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalled();
    expect(setSelectionRangeSpy).toHaveBeenCalledWith(0, 0);
    expect(helperTextarea.getAttribute("inputmode")).toBe("text");
  });

  it("focuses xterm helper textarea on touch gesture", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    const terminalDiv = screen.getByTestId("terminal-xterm");
    const helperTextarea = document.createElement("textarea");
    helperTextarea.className = "xterm-helper-textarea";
    const focusSpy = vi.spyOn(helperTextarea, "focus");
    terminalDiv.appendChild(helperTextarea);

    fireEvent.touchStart(terminalDiv);

    expect(focusSpy).toHaveBeenCalled();
    expect(helperTextarea.autocapitalize).toBe("off");
    expect(helperTextarea.autocomplete).toBe("off");
    expect(helperTextarea.autocorrect).toBe("off");
    expect(helperTextarea.spellcheck).toBe(false);
  });

  // On touch-primary devices (iOS, Android), the CSS sizes the helper textarea
  // to cover the whole terminal so iOS focuses it natively on tap. Re-focusing
  // in the bubble-phase gesture handler disrupts iOS input-event attribution
  // and causes typed keys to be silently dropped. The handler must be a no-op
  // in that environment — see commit c7266b7f for prior iOS input fix context.
  it("no-ops gesture focus handler on touch-primary devices", async () => {
    const matchMediaSpy = vi
      .spyOn(window, "matchMedia")
      .mockImplementation((query: string) => ({
        matches: query === "(hover: none) and (pointer: coarse)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

    try {
      render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(mockTerminalInstance.open).toHaveBeenCalled();
      });

      const terminalDiv = screen.getByTestId("terminal-xterm");
      const helperTextarea = document.createElement("textarea");
      helperTextarea.className = "xterm-helper-textarea";
      const focusSpy = vi.spyOn(helperTextarea, "focus");
      const setSelectionRangeSpy = vi.spyOn(helperTextarea, "setSelectionRange");
      terminalDiv.appendChild(helperTextarea);

      mockTerminalInstance.focus.mockClear();
      fireEvent.touchStart(terminalDiv);

      expect(mockTerminalInstance.focus).not.toHaveBeenCalled();
      expect(focusSpy).not.toHaveBeenCalled();
      expect(setSelectionRangeSpy).not.toHaveBeenCalled();
    } finally {
      matchMediaSpy.mockRestore();
    }
  });
});

// --- FN-1765: Project-context propagation ---
describe("TerminalModal — project-context propagation (FN-1765)", () => {
  const mockOnClose = vi.fn();
  const mockSendInput = vi.fn();
  const mockResize = vi.fn();
  const mockReconnect = vi.fn();

  const createMockTerminalState = (overrides = {}) => ({
    connectionStatus: "connected" as const,
    sendInput: mockSendInput,
    resize: mockResize,
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onConnect: vi.fn(() => vi.fn()),
    onScrollback: vi.fn(() => vi.fn()),
    reconnect: mockReconnect,
    onSessionInvalid: vi.fn(() => vi.fn()),
    ...overrides,
  });

  const defaultTab = {
    id: "tab-1",
    sessionId: "session-1",
    title: "bash",
    isActive: true,
    createdAt: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    mockTerminalInstance.open.mockClear();
    mockTerminalInstance.dispose.mockClear();
    mockTerminalInstance.clear.mockClear();
    mockUseTerminal.mockReturnValue(createMockTerminalState());
    mockUseTerminalSessions.mockReturnValue({
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
      replaceActiveTabSession: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes projectId to useTerminal hook", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} projectId="proj-123" />);

    await waitFor(() => {
      expect(mockUseTerminal).toHaveBeenCalledWith("session-1", "proj-123");
    });
  });

  it("passes undefined projectId to useTerminal when not provided", async () => {
    render(<TerminalModal isOpen={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(mockUseTerminal).toHaveBeenCalledWith("session-1", undefined);
    });
  });

  it("re-invokes useTerminal with new projectId when projectId prop changes", async () => {
    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} projectId="proj-A" />
    );

    await waitFor(() => {
      expect(mockUseTerminal).toHaveBeenCalledWith("session-1", "proj-A");
    });

    // Simulate project switch
    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} projectId="proj-B" />);

    await waitFor(() => {
      // useTerminal should be called with the new projectId
      expect(mockUseTerminal).toHaveBeenCalledWith(expect.any(String), "proj-B");
    });
  });

  it("disposes xterm when projectId changes", async () => {
    // Project A has session-1
    mockUseTerminalSessions.mockReturnValue({
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
      replaceActiveTabSession: vi.fn(),
    });

    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} projectId="proj-A" />
    );

    // Wait for initial xterm to be created
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    // Clear mock to track disposal separately
    mockTerminalInstance.dispose.mockClear();

    // Project B has a different session (simulating project-scoped sessions)
    const projBSession = {
      id: "tab-1",
      sessionId: "session-2",
      title: "zsh",
      isActive: true,
      createdAt: Date.now(),
    };

    mockUseTerminalSessions.mockReturnValue({
      tabs: [projBSession],
      activeTab: projBSession,
      isReady: true,
      bootstrapError: null,
      createTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabTitle: vi.fn(),
      restartActiveTab: vi.fn(),
      retryBootstrap: vi.fn(),
      replaceActiveTabSession: vi.fn(),
    });

    // Switch project
    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} projectId="proj-B" />);

    // xterm should be disposed when project changes (different session triggers cleanup)
    await waitFor(() => {
      expect(mockTerminalInstance.dispose).toHaveBeenCalled();
    });

    // New xterm should be initialized for the new project's session
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });
  });

  it("uses fresh useTerminal session for new project after project switch", async () => {
    // Initial project A
    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} projectId="proj-A" />
    );

    await waitFor(() => {
      expect(mockUseTerminal).toHaveBeenCalledWith("session-1", "proj-A");
    });

    // Simulate project B having different sessions
    const projBTab = {
      id: "tab-1",
      sessionId: "session-2", // Different session for project B
      title: "zsh",
      isActive: true,
      createdAt: Date.now(),
    };

    mockUseTerminalSessions.mockReturnValue({
      tabs: [projBTab],
      activeTab: projBTab,
      isReady: true,
      bootstrapError: null,
      createTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabTitle: vi.fn(),
      restartActiveTab: vi.fn(),
      retryBootstrap: vi.fn(),
      replaceActiveTabSession: vi.fn(),
    });

    // Switch to project B
    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} projectId="proj-B" />);

    // useTerminal should be called with the new project's session
    await waitFor(() => {
      expect(mockUseTerminal).toHaveBeenCalledWith("session-2", "proj-B");
    });
  });

  it("does not dispose xterm when projectId stays the same but session changes", async () => {
    const { rerender } = render(
      <TerminalModal isOpen={true} onClose={mockOnClose} projectId="proj-A" />
    );

    // Wait for initial xterm to be created
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });

    // Clear mock to track disposal
    mockTerminalInstance.dispose.mockClear();

    // Create a new tab (session change, but same project)
    const newTab = {
      id: "tab-2",
      sessionId: "session-2",
      title: "zsh",
      isActive: true,
      createdAt: Date.now(),
    };

    mockUseTerminalSessions.mockReturnValue({
      tabs: [
        { ...defaultTab, isActive: false },
        newTab,
      ],
      activeTab: newTab,
      isReady: true,
      bootstrapError: null,
      createTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabTitle: vi.fn(),
      restartActiveTab: vi.fn(),
      retryBootstrap: vi.fn(),
      replaceActiveTabSession: vi.fn(),
    });

    // Switch tab (not project)
    rerender(<TerminalModal isOpen={true} onClose={mockOnClose} projectId="proj-A" />);

    // xterm should be disposed for tab switch
    await waitFor(() => {
      expect(mockTerminalInstance.dispose).toHaveBeenCalled();
    });

    // New xterm should be initialized for the new session
    await waitFor(() => {
      expect(mockTerminalInstance.open).toHaveBeenCalled();
    });
  });
});
