/*
FNXC:TerminalLayout 2026-09-15-21:04:
FN-434 symptom acceptance. Three reported defects, proven here on the real `TerminalModal`:

1. the pinned panel is a FIXED height and its top grip DETACHES instead of resizing (an inverted top-edge resize
   cannot exist when there is no resize gesture at all);
2. a floating terminal re-pins only when a COMPLETED pointer gesture actually moves an unsnapped window's bottom
   edge onto the footer line — mount, a snapped window, and a click without movement are counter-proofs;
3. the live xterm element is re-attached to the current container on every presentation change, so the console is
   never a blank panel again.

jsdom reports a zero rectangle for every element, so each contact case installs explicit rectangles (different
before and after the gesture, so the 6px movement floor is genuinely crossed) and explicit viewport dimensions.
*/
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowManagerProvider, useDashboardWindowLandmark } from "../../context/DashboardWindowManagerContext";
import { FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT } from "../FloatingWindow";
import { TerminalModal, _resetInitialViewportHeight } from "../TerminalModal";

const HEADER_HEIGHT = 64;
const FOOTER_HEIGHT = 36;

vi.mock("../../hooks/useTerminal", () => ({ useTerminal: vi.fn() }));
vi.mock("../../hooks/useTerminalSessions", () => ({ useTerminalSessions: vi.fn() }));
vi.mock("../../hooks/useWorkspaces", () => ({ useWorkspaces: vi.fn() }));
vi.mock("../../api", () => ({
  createTerminalSession: vi.fn(),
  killPtyTerminalSession: vi.fn(),
  listTerminalSessions: vi.fn().mockResolvedValue([]),
}));

/*
Mirrors the part of real xterm this task depends on: `open(container)` appends the terminal's own element to the
container and records it on `terminal.element`, which is exactly the handle production code re-attaches.
*/
interface MockXterm {
  element: HTMLElement | null;
  open: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

let mockXtermInstances: MockXterm[] = [];
let mockXtermOmitsElement = false;
const mockFit = vi.fn();

function createMockXterm(): MockXterm {
  const instance: MockXterm = {
    element: null,
    open: vi.fn((container: HTMLElement) => {
      if (mockXtermOmitsElement) return;
      const element = document.createElement("div");
      element.className = "xterm";
      element.setAttribute("data-mock-xterm", "true");
      container.appendChild(element);
      instance.element = element;
    }),
    write: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(() => {
      instance.element?.remove();
      instance.element = null;
    }),
    focus: vi.fn(),
    refresh: vi.fn(),
    loadAddon: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    textarea: document.createElement("textarea"),
    options: {},
    cols: 80,
    rows: 24,
  };
  mockXtermInstances.push(instance);
  return instance;
}

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function TerminalMock() {
    return createMockXterm();
  }),
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function FitAddonMock() {
    return { fit: mockFit, dispose: vi.fn() };
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

function domRect(value: { left: number; top: number; right: number; bottom: number }): DOMRect {
  const rect = {
    ...value,
    width: value.right - value.left,
    height: value.bottom - value.top,
    x: value.left,
    y: value.top,
    toJSON: () => ({}),
  };
  return rect as DOMRect;
}

const ZERO_RECT = domRect({ left: 0, top: 0, right: 0, bottom: 0 });

/** Rect override applied to the floating panel, replaced mid-gesture to model a real move. */
let panelRect: DOMRect | null = null;

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

function prepareCapture(target: HTMLElement) {
  Object.defineProperty(target, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(target, "releasePointerCapture", { configurable: true, value: vi.fn() });
}

function renderTerminal(projectId: string, options?: { mode?: "below" | "floating"; embedded?: boolean }) {
  window.localStorage.setItem(`fusion:terminal-display-mode-${projectId}`, options?.mode ?? "below");
  return render(
    <DashboardWindowManagerProvider>
      <Landmarks />
      <TerminalModal
        isOpen={true}
        onClose={() => {}}
        projectId={projectId}
        footerVisible={true}
        embedded={options?.embedded}
      />
    </DashboardWindowManagerProvider>,
  );
}

function storedMode(projectId: string): string | null {
  return window.localStorage.getItem(`fusion:terminal-display-mode-${projectId}`);
}

function liveXterm(): MockXterm | undefined {
  return mockXtermInstances.filter((instance) => instance.element !== null).at(-1);
}

/** Drags the pinned grip vertically by `deltaY`, returning nothing; the caller asserts the resulting mode. */
function dragPinnedHandle(deltaY: number, pointerId = 1) {
  const handle = screen.getByTestId("terminal-pinned-drag-handle");
  prepareCapture(handle);
  fireEvent.pointerDown(handle, { pointerId, clientY: 400 });
  fireEvent.pointerMove(handle, { pointerId, clientY: 400 + deltaY });
  fireEvent.pointerUp(handle, { pointerId, clientY: 400 + deltaY });
}

/** Full pointer gesture on the floating panel: press, move the panel's rectangle, release. */
function moveFloatingPanel(panel: HTMLElement, from: DOMRect, to: DOMRect, pointerId = 5) {
  const header = panel.querySelector(".terminal-header") as HTMLElement;
  panelRect = from;
  prepareCapture(header);
  fireEvent.pointerDown(header, { pointerId, pointerType: "mouse", button: 0, clientX: 600, clientY: 300 });
  panelRect = to;
  fireEvent.pointerMove(header, { pointerId, pointerType: "mouse", clientX: 600, clientY: 300 + (to.top - from.top) });
  fireEvent.pointerUp(header, { pointerId, pointerType: "mouse", clientX: 600, clientY: 300 + (to.top - from.top) });
}

describe("pinned terminal detach / footer-contact re-pin", () => {
  beforeEach(() => {
    localStorage.clear();
    mockXtermInstances = [];
    mockXtermOmitsElement = false;
    mockFit.mockClear();
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

    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    _resetInitialViewportHeight();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    panelRect = null;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const name = this.dataset.landmark;
      if (name === "header") return domRect({ left: 0, top: 0, right: window.innerWidth, bottom: HEADER_HEIGHT });
      if (name === "footer") {
        return domRect({ left: 0, top: window.innerHeight - FOOTER_HEIGHT, right: window.innerWidth, bottom: window.innerHeight });
      }
      if (panelRect && this.classList.contains("floating-window")) return panelRect;
      return ZERO_RECT;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetInitialViewportHeight();
    delete (window as unknown as { ontouchstart?: unknown }).ontouchstart;
  });

  /* (a) A grip drag under the detach threshold leaves the terminal pinned — a click never detaches. */
  it("keeps the terminal pinned for a grip drag under the detach threshold", async () => {
    renderTerminal("detach-threshold");
    await screen.findByTestId("terminal-below-host");

    dragPinnedHandle(8);

    expect(screen.getByTestId("terminal-modal")).toHaveClass("terminal-modal--below");
    expect(storedMode("detach-threshold")).toBe("below");
  });

  /* (b)+(c) Detach on drag, then re-pin, with the live xterm element following the current container each time. */
  it("detaches on a grip drag and keeps the console attached across pinned -> floating -> pinned", async () => {
    renderTerminal("detach-drag");
    await screen.findByTestId("terminal-below-host");
    await waitFor(() => expect(liveXterm()).toBeDefined());

    const containerOf = (element: HTMLElement | null) => element?.parentElement ?? null;
    const pinnedContainer = containerOf(liveXterm()!.element);
    expect(pinnedContainer).not.toBeNull();

    dragPinnedHandle(40);

    await waitFor(() => expect(screen.getByTestId("terminal-modal")).toHaveClass("terminal-modal--floating"));
    expect(storedMode("detach-drag")).toBe("floating");

    // The console must be inside the FLOATING presentation's container, not stranded on the detached pinned node.
    await waitFor(() => {
      const element = liveXterm()!.element!;
      expect(element.isConnected).toBe(true);
      expect(screen.getByTestId("floating-window-terminal-detach-drag")).toContainElement(element);
    });
    const refreshBaseline = liveXterm()!.refresh.mock.calls.length;
    const fitBaseline = mockFit.mock.calls.length;

    fireEvent.click(screen.getByTestId("terminal-popout-toggle"));

    await waitFor(() => expect(screen.getByTestId("terminal-below-host")).toBeInTheDocument());
    await waitFor(() => {
      const element = liveXterm()!.element!;
      expect(element.isConnected).toBe(true);
      expect(screen.getByTestId("terminal-below-host")).toContainElement(element);
    });
    expect(liveXterm()!.refresh.mock.calls.length).toBeGreaterThan(refreshBaseline);
    expect(mockFit.mock.calls.length).toBeGreaterThan(fitBaseline);
  });

  /* (d) A real move that stops above the footer line must NOT re-pin. */
  it("keeps the window detached when the gesture ends above the footer line", async () => {
    renderTerminal("repin-above", { mode: "floating" });
    const panel = await screen.findByTestId("floating-window-terminal-repin-above");

    moveFloatingPanel(
      panel,
      domRect({ left: 200, top: 100, right: 1000, bottom: 500 }),
      domRect({ left: 200, top: 200, right: 1000, bottom: 600 }),
    );

    expect(panel.dataset.snapMode).toBe("floating");
    expect(storedMode("repin-above")).toBe("floating");
    expect(screen.queryByTestId("terminal-below-host")).toBeNull();
  });

  /* (e) A real move that brings the bottom edge onto the footer line re-pins on release. */
  it("re-pins when a move gesture brings the bottom edge onto the footer line", async () => {
    renderTerminal("repin-contact", { mode: "floating" });
    const panel = await screen.findByTestId("floating-window-terminal-repin-contact");

    const footerLine = window.innerHeight - FOOTER_HEIGHT;
    moveFloatingPanel(
      panel,
      domRect({ left: 200, top: 100, right: 1000, bottom: 500 }),
      domRect({ left: 200, top: footerLine - 400, right: 1000, bottom: footerLine }),
    );

    await waitFor(() => expect(screen.getByTestId("terminal-below-host")).toBeInTheDocument());
    expect(storedMode("repin-contact")).toBe("below");
    expect(screen.getByTestId("terminal-modal")).toHaveClass("terminal-modal--below");
  });

  /* (k) Mounting the floating window publishes geometry with no gesture at all: it must stay detached. */
  it("stays detached when the floating window mounts already touching the footer line", async () => {
    const footerLine = window.innerHeight - FOOTER_HEIGHT;
    panelRect = domRect({ left: 200, top: footerLine - 400, right: 1000, bottom: footerLine });

    renderTerminal("repin-mount", { mode: "floating" });
    await screen.findByTestId("floating-window-terminal-repin-mount");

    fireEvent(window, new CustomEvent(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, { detail: { windowKey: "terminal-repin-mount" } }));

    await waitFor(() => expect(storedMode("repin-mount")).toBe("floating"));
    expect(screen.queryByTestId("terminal-below-host")).toBeNull();
  });

  /* (l) A snapped window sits on the footer line by construction; a full gesture must still not re-pin. */
  it.each(["bottom", "maximized"])("stays detached for a %s-snapped window resting on the footer line", async (snapMode) => {
    const projectId = `repin-snap-${snapMode}`;
    renderTerminal(projectId, { mode: "floating" });
    const panel = await screen.findByTestId(`floating-window-terminal-${projectId}`);
    panel.dataset.snapMode = snapMode;

    const footerLine = window.innerHeight - FOOTER_HEIGHT;
    moveFloatingPanel(
      panel,
      domRect({ left: 0, top: HEADER_HEIGHT, right: 1440, bottom: footerLine - 100 }),
      domRect({ left: 0, top: HEADER_HEIGHT, right: 1440, bottom: footerLine }),
    );

    expect(storedMode(projectId)).toBe("floating");
    expect(screen.queryByTestId("terminal-below-host")).toBeNull();
  });

  /* (m) A click on the header moves nothing: no re-pin, even when the rectangle already touches the footer. */
  it("stays detached for a click without movement on the window header", async () => {
    renderTerminal("repin-click", { mode: "floating" });
    const panel = await screen.findByTestId("floating-window-terminal-repin-click");

    const footerLine = window.innerHeight - FOOTER_HEIGHT;
    const resting = domRect({ left: 200, top: footerLine - 400, right: 1000, bottom: footerLine });
    panelRect = resting;
    const header = panel.querySelector(".terminal-header") as HTMLElement;
    prepareCapture(header);
    fireEvent.pointerDown(header, { pointerId: 9, pointerType: "mouse", button: 0, clientX: 600, clientY: 500 });
    fireEvent.pointerUp(header, { pointerId: 9, pointerType: "mouse", clientX: 600, clientY: 502 });

    expect(storedMode("repin-click")).toBe("floating");
    expect(screen.queryByTestId("terminal-below-host")).toBeNull();
  });

  /* (h) No session: switching presentation must be a silent no-op, never a throw. */
  it("switches presentation without a session without throwing", async () => {
    vi.mocked(useTerminalSessions).mockReturnValue({
      tabs: [],
      activeTab: null,
      isReady: true,
      autoCreateDisabled: true,
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

    renderTerminal("repin-no-session");
    await screen.findByTestId("terminal-below-host");
    expect(mockXtermInstances).toHaveLength(0);

    expect(() => dragPinnedHandle(40)).not.toThrow();
    await waitFor(() => expect(screen.getByTestId("terminal-modal")).toHaveClass("terminal-modal--floating"));
    expect(mockXtermInstances.some((instance) => instance.element !== null)).toBe(false);
  });

  /* (i) An instance with no element cannot be re-attached: the fallback must re-create it in the new container. */
  it("recreates the terminal when the existing instance has no element to re-attach", async () => {
    mockXtermOmitsElement = true;
    renderTerminal("repin-fallback");
    await screen.findByTestId("terminal-below-host");
    await waitFor(() => expect(mockXtermInstances.length).toBeGreaterThan(0));
    const openCallsBaseline = mockXtermInstances.reduce((total, instance) => total + instance.open.mock.calls.length, 0);

    mockXtermOmitsElement = false;
    dragPinnedHandle(40);

    await waitFor(() => expect(screen.getByTestId("terminal-modal")).toHaveClass("terminal-modal--floating"));
    await waitFor(() => {
      const openCalls = mockXtermInstances.reduce((total, instance) => total + instance.open.mock.calls.length, 0);
      expect(openCalls).toBeGreaterThan(openCallsBaseline);
    });
    await waitFor(() => {
      const element = liveXterm()?.element;
      expect(element).toBeTruthy();
      expect(screen.getByTestId("floating-window-terminal-repin-fallback")).toContainElement(element!);
    });
  });

  /* (j) A populated session keeps its already-written scrollback mounted across the presentation change. */
  it("keeps populated terminal content mounted across a presentation change", async () => {
    renderTerminal("repin-populated");
    await screen.findByTestId("terminal-below-host");
    await waitFor(() => expect(liveXterm()).toBeDefined());
    const element = liveXterm()!.element!;
    element.textContent = "previous shell output";

    dragPinnedHandle(40);

    await waitFor(() => expect(screen.getByTestId("terminal-modal")).toHaveClass("terminal-modal--floating"));
    await waitFor(() => {
      const current = liveXterm()!.element!;
      expect(current).toBe(element);
      expect(current.textContent).toBe("previous shell output");
      expect(screen.getByTestId("floating-window-terminal-repin-populated")).toContainElement(current);
    });
  });

  /* (f) Phone: no detach grip and no re-pin path at all. */
  it("exposes neither the detach grip nor a re-pin path on a phone", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    Object.defineProperty(window, "ontouchstart", { configurable: true, value: null });
    _resetInitialViewportHeight();

    renderTerminal("repin-phone", { mode: "floating" });
    await screen.findByTestId("terminal-modal");

    expect(screen.queryByTestId("terminal-pinned-drag-handle")).toBeNull();
    expect(screen.queryByTestId("floating-window-terminal-repin-phone")).toBeNull();

    fireEvent.pointerDown(document.body, { pointerId: 3, pointerType: "touch", clientY: 800 });
    fireEvent.pointerUp(document.body, { pointerId: 3, pointerType: "touch", clientY: 890 });
    expect(storedMode("repin-phone")).toBe("floating");
  });

  /* (g) Embedded: parent-owned layout, so no grip and no display-mode change. */
  it("exposes no detach grip and never changes display mode when embedded", async () => {
    renderTerminal("repin-embedded", { embedded: true });
    await screen.findByTestId("terminal-embedded-host");

    expect(screen.queryByTestId("terminal-pinned-drag-handle")).toBeNull();
    expect(screen.queryByTestId("terminal-below-host")).toBeNull();
    expect(screen.queryByTestId("floating-window-terminal-repin-embedded")).toBeNull();
    expect(storedMode("repin-embedded")).toBe("below");
  });

  /* Tablet replays the desktop gestures: detach, no-contact release, and footer-contact re-pin. */
  describe("tablet viewport", () => {
    beforeEach(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
      _resetInitialViewportHeight();
    });

    it("detaches on a grip drag and re-pins only on a footer-contact move gesture", async () => {
      renderTerminal("tablet-gestures");
      await screen.findByTestId("terminal-below-host");

      dragPinnedHandle(40);
      await waitFor(() => expect(storedMode("tablet-gestures")).toBe("floating"));
      const panel = await screen.findByTestId("floating-window-terminal-tablet-gestures");

      // A move that stops short of the footer line stays detached.
      moveFloatingPanel(
        panel,
        domRect({ left: 100, top: 100, right: 900, bottom: 500 }),
        domRect({ left: 100, top: 150, right: 900, bottom: 550 }),
        11,
      );
      expect(storedMode("tablet-gestures")).toBe("floating");

      // A click on the header, already resting on the line, still stays detached.
      const footerLine = window.innerHeight - FOOTER_HEIGHT;
      const resting = domRect({ left: 100, top: footerLine - 400, right: 900, bottom: footerLine });
      panelRect = resting;
      const header = panel.querySelector(".terminal-header") as HTMLElement;
      prepareCapture(header);
      fireEvent.pointerDown(header, { pointerId: 12, pointerType: "mouse", button: 0, clientX: 500, clientY: 500 });
      fireEvent.pointerUp(header, { pointerId: 12, pointerType: "mouse", clientX: 500, clientY: 500 });
      expect(storedMode("tablet-gestures")).toBe("floating");

      // And a genuine move onto the line re-pins.
      moveFloatingPanel(
        panel,
        domRect({ left: 100, top: 100, right: 900, bottom: 500 }),
        resting,
        13,
      );
      await waitFor(() => expect(storedMode("tablet-gestures")).toBe("below"));
      expect(screen.getByTestId("terminal-below-host")).toBeInTheDocument();
    });
  });
});
