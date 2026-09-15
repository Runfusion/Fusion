import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowManagerProvider, useDashboardWindowLandmark } from "../../context/DashboardWindowManagerContext";
import {
  FLOATING_WINDOW_STANDARD_HEIGHT_RATIO,
  FLOATING_WINDOW_TASK_STANDARD_HEIGHT,
  FloatingWindow,
} from "../FloatingWindow";
import { TerminalModal, _resetInitialViewportHeight } from "../TerminalModal";

/*
FNXC:TerminalLayout 2026-09-15-07:57:
FN-409 symptom acceptance (3): the DETACHED terminal must behave like a task or conversation window, not like a
utility surface of its own. These regressions drive real pointer gestures on the real terminal header, mirroring
the `FloatingWindow.snap.test.tsx` work-area harness (landmarks + mocked landmark rectangles), and assert the
rendered rectangle plus the shared stacking order:

- dragging the panel against the right wall arms `data-snap-zone="right"` and applies `data-snap-mode="right"`;
- dragging to the top band fills the work area, and detaching restores the floating rect;
- a pointerdown on the terminal panel raises it above a window mounted AFTER it, and vice versa;
- the phone sheet presentation exposes neither snapping nor resize handles.

FNXC:TerminalLayout 2026-09-15-14:07:
FN-422 makes undocking omnidirectional, and the detached terminal inherits it through the shared drag handler:
the filled work area is now released by any drag past the click threshold, not only by a downward one.
*/

const HEADER_HEIGHT = 64;
const FOOTER_HEIGHT = 36;

/*
FNXC:TerminalWindow 2026-09-15-13:41:
FN-418 caps the standard OPENING height at a proportion of the live work area, so the parity assertion derives
the expected height from that contract. The parity invariant is unchanged: a detached terminal still opens at
the same standard rectangle as a task window.
*/
function standardOpeningHeight(): number {
  const workArea = window.innerHeight - HEADER_HEIGHT - FOOTER_HEIGHT;
  return Math.min(FLOATING_WINDOW_TASK_STANDARD_HEIGHT, Math.round(workArea * FLOATING_WINDOW_STANDARD_HEIGHT_RATIO));
}

vi.mock("../../hooks/useTerminal", () => ({ useTerminal: vi.fn() }));
vi.mock("../../hooks/useTerminalSessions", () => ({ useTerminalSessions: vi.fn() }));
vi.mock("../../hooks/useWorkspaces", () => ({ useWorkspaces: vi.fn() }));
vi.mock("../../api", () => ({
  createTerminalSession: vi.fn(),
  killPtyTerminalSession: vi.fn(),
  listTerminalSessions: vi.fn().mockResolvedValue([]),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function TerminalMock() {
    return {
      open: vi.fn(),
      write: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
      focus: vi.fn(),
      refresh: vi.fn(),
      loadAddon: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomKeyEventHandler: vi.fn(),
      element: document.createElement("div"),
      textarea: document.createElement("textarea"),
      options: {},
      cols: 80,
      rows: 24,
    };
  }),
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function FitAddonMock() {
    return { fit: vi.fn(), dispose: vi.fn() };
  }),
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(function WebLinksAddonMock() {
    return { dispose: vi.fn() };
  }),
}));
vi.mock("@xterm/addon-webgl", () => {
  throw new Error("WebGL not available");
});
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const { useTerminal } = await import("../../hooks/useTerminal");
const { useTerminalSessions } = await import("../../hooks/useTerminalSessions");
const { useWorkspaces } = await import("../../hooks/useWorkspaces");

const tab = { id: "tab-1", sessionId: "session-1", title: "bash", isActive: true, createdAt: 0 };

function domRect(value: { left: number; top: number; right: number; bottom: number; width: number; height: number }): DOMRect {
  return { ...value, x: value.left, y: value.top, toJSON: () => ({}) } as DOMRect;
}

function Landmarks() {
  const headerRef = useDashboardWindowLandmark("header");
  const footerRef = useDashboardWindowLandmark("footer");
  return (
    <>
      <header ref={headerRef} data-landmark="header" />
      <footer ref={footerRef} data-landmark="footer" />
    </>
  );
}

function rectOf(panel: HTMLElement) {
  return {
    left: Number.parseFloat(panel.style.left),
    top: Number.parseFloat(panel.style.top),
    width: Number.parseFloat(panel.style.width),
    height: Number.parseFloat(panel.style.height),
  };
}

function prepareCapture(target: HTMLElement) {
  Object.defineProperty(target, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(target, "releasePointerCapture", { configurable: true, value: vi.fn() });
}

interface Gesture {
  from?: { x: number; y: number };
  via?: { x: number; y: number }[];
  to: { x: number; y: number };
  pointerId?: number;
  hold?: boolean;
}

function drag(handle: HTMLElement, gesture: Gesture) {
  const pointerId = gesture.pointerId ?? 1;
  const from = gesture.from ?? { x: 600, y: 400 };
  prepareCapture(handle);
  fireEvent.pointerDown(handle, { pointerId, pointerType: "mouse", clientX: from.x, clientY: from.y, button: 0 });
  for (const point of gesture.via ?? []) {
    fireEvent.pointerMove(handle, { pointerId, pointerType: "mouse", clientX: point.x, clientY: point.y });
  }
  fireEvent.pointerMove(handle, { pointerId, pointerType: "mouse", clientX: gesture.to.x, clientY: gesture.to.y });
  if (gesture.hold) return;
  fireEvent.pointerUp(handle, { pointerId, pointerType: "mouse", clientX: gesture.to.x, clientY: gesture.to.y });
}

function renderDetachedTerminal(projectId: string, extra?: React.ReactNode) {
  window.localStorage.setItem(`fusion:terminal-display-mode-${projectId}`, "floating");
  const view = render(
    <DashboardWindowManagerProvider>
      <Landmarks />
      <TerminalModal isOpen={true} onClose={() => {}} projectId={projectId} />
      {extra}
    </DashboardWindowManagerProvider>,
  );
  return view;
}

describe("detached terminal window parity", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(useTerminal).mockReturnValue({
      connectionStatus: "connected",
      sendInput: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      onConnect: vi.fn(() => vi.fn()),
      onScrollback: vi.fn(() => vi.fn()),
      reconnect: vi.fn(),
      onSessionInvalid: vi.fn(() => vi.fn()),
    } as unknown as ReturnType<typeof useTerminal>);
    vi.mocked(useTerminalSessions).mockReturnValue({
      tabs: [tab],
      activeTab: tab,
      isReady: true,
      autoCreateDisabled: false,
      bootstrapError: null,
      createTab: vi.fn(),
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      updateTabTitle: vi.fn(),
      restartActiveTab: vi.fn(),
      retryBootstrap: vi.fn(),
      replaceActiveTabSession: vi.fn().mockResolvedValue(undefined),
      detachedSessions: [],
      refreshDetachedSessions: vi.fn().mockResolvedValue(undefined),
      reopenSession: vi.fn(),
    } as unknown as ReturnType<typeof useTerminalSessions>);
    vi.mocked(useWorkspaces).mockReturnValue({
      projectName: "kb",
      workspaces: [],
      loading: false,
      error: null,
    } as unknown as ReturnType<typeof useWorkspaces>);

    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });
    _resetInitialViewportHeight();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const name = this.dataset.landmark;
      if (name === "header") return domRect({ left: 0, top: 0, right: window.innerWidth, bottom: HEADER_HEIGHT, width: window.innerWidth, height: HEADER_HEIGHT });
      if (name === "footer") return domRect({ left: 0, top: window.innerHeight - FOOTER_HEIGHT, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: FOOTER_HEIGHT });
      return domRect({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetInitialViewportHeight();
  });

  it("opens at the standard task-window size inside the work area", async () => {
    renderDetachedTerminal("parity-size");

    const panel = await screen.findByTestId("floating-window-terminal-parity-size");
    await waitFor(() => expect(rectOf(panel).width).toBe(800));
    expect(rectOf(panel).height).toBe(standardOpeningHeight());
  });

  it("snaps the detached terminal to the right half from its own header", async () => {
    renderDetachedTerminal("parity-snap-right");

    const panel = await screen.findByTestId("floating-window-terminal-parity-snap-right");
    await waitFor(() => expect(rectOf(panel).width).toBe(800));
    const handle = panel.querySelector(".terminal-header") as HTMLElement;

    drag(handle, { from: { x: 600, y: 400 }, to: { x: 1000, y: 400 }, pointerId: 10, hold: true });
    expect(screen.getByTestId("floating-window-snap-preview-terminal-parity-snap-right").dataset.snapZone).toBe("right");

    fireEvent.pointerUp(handle, { pointerId: 10, pointerType: "mouse", clientX: 1000, clientY: 400 });
    expect(panel.dataset.snapMode).toBe("right");
    expect(rectOf(panel)).toEqual({ left: 640, top: HEADER_HEIGHT, width: 640, height: 700 });
  });

  it("fills the work area from the top band and detaches back to the previous rectangle", async () => {
    renderDetachedTerminal("parity-snap-top");

    const panel = await screen.findByTestId("floating-window-terminal-parity-snap-top");
    await waitFor(() => expect(rectOf(panel).width).toBe(800));
    const handle = panel.querySelector(".terminal-header") as HTMLElement;
    const floating = rectOf(panel);

    drag(handle, { from: { x: 600, y: 400 }, to: { x: 600, y: HEADER_HEIGHT + 4 }, pointerId: 11 });
    expect(panel.dataset.snapMode).toBe("maximized");
    expect(rectOf(panel)).toEqual({ left: 0, top: HEADER_HEIGHT, width: 1280, height: 700 });

    // Any drag past the click threshold releases the filled work area; downward is only one of them.
    drag(handle, { from: { x: 600, y: 200 }, to: { x: 600, y: 240 }, pointerId: 12 });
    expect(panel.dataset.snapMode).toBe("floating");
    expect(rectOf(panel).width).toBe(floating.width);
    expect(rectOf(panel).height).toBe(floating.height);
  });

  /*
  FNXC:TerminalLayout 2026-09-15-14:07:
  FN-422 symptom acceptance on a REAL host: a maximized detached terminal must come loose on a NON-downward
  gesture too. Before FN-422 this upward drag left the terminal filling the work area, which is exactly the
  "the window is stuck" report.
  */
  it("releases the filled work area on a non-downward drag", async () => {
    renderDetachedTerminal("parity-undock-up");

    const panel = await screen.findByTestId("floating-window-terminal-parity-undock-up");
    await waitFor(() => expect(rectOf(panel).width).toBe(800));
    const handle = panel.querySelector(".terminal-header") as HTMLElement;
    const floating = rectOf(panel);

    drag(handle, { from: { x: 600, y: 400 }, to: { x: 600, y: HEADER_HEIGHT + 4 }, pointerId: 13 });
    expect(panel.dataset.snapMode).toBe("maximized");

    drag(handle, { from: { x: 640, y: 400 }, to: { x: 640, y: 360 }, pointerId: 14 });
    expect(panel.dataset.snapMode).toBe("floating");
    expect(rectOf(panel).width).toBe(floating.width);
    expect(rectOf(panel).height).toBe(floating.height);
  });

  it("raises the detached terminal above a task window mounted after it, and the reverse", async () => {
    renderDetachedTerminal(
      "parity-stack",
      <FloatingWindow windowKey="task-detail-FN-409" title="Task" onClose={() => {}} layer="task-detail">
        <div>task body</div>
      </FloatingWindow>,
    );

    const terminal = await screen.findByTestId("floating-window-terminal-parity-stack");
    const task = screen.getByTestId("floating-window-task-detail-FN-409");
    const zOf = (panel: HTMLElement) => Number.parseFloat(panel.style.zIndex);

    // Mounted last, the task window starts on top.
    expect(zOf(task)).toBeGreaterThan(zOf(terminal));

    fireEvent.pointerDown(terminal.querySelector(".terminal-header") as HTMLElement, { pointerId: 20, pointerType: "mouse", clientX: 600, clientY: 400, button: 0 });
    expect(zOf(terminal)).toBeGreaterThan(zOf(task));

    fireEvent.pointerDown(task, { pointerId: 21, pointerType: "mouse", clientX: 100, clientY: 100, button: 0 });
    expect(zOf(task)).toBeGreaterThan(zOf(terminal));
  });

  it("exposes neither snapping nor resize handles in the phone sheet presentation", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    Object.defineProperty(window, "ontouchstart", { configurable: true, value: null });
    _resetInitialViewportHeight();

    try {
      renderDetachedTerminal("parity-sheet");

      await screen.findByTestId("terminal-modal");
      expect(screen.queryByTestId("floating-window-terminal-parity-sheet")).toBeNull();
      expect(screen.queryByTestId("floating-window-snap-preview-terminal-parity-sheet")).toBeNull();
      expect(screen.queryByTestId("floating-window-resize-se")).toBeNull();
      expect(screen.queryByTestId("terminal-popout-toggle")).toBeNull();
    } finally {
      delete (window as unknown as { ontouchstart?: unknown }).ontouchstart;
    }
  });
});
