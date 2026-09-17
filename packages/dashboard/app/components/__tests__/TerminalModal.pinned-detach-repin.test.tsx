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

/*
Drags the pinned grip vertically by `deltaY`, returning nothing; the caller asserts the resulting mode.

FNXC:TerminalLayout 2026-09-16-18:31:
FN-469: the gesture now carries a HORIZONTAL coordinate too, because the detached window is placed under the pointer.
An omitted `clientX` meant `0`, which pulled the window out flush against the left wall and made every later drag arm
the left column — an artifact of the fixture, not of the product.
*/
function dragPinnedHandle(deltaY: number, pointerId = 1) {
  const handle = screen.getByTestId("terminal-pinned-drag-handle");
  prepareCapture(handle);
  fireEvent.pointerDown(handle, { pointerId, clientX: 600, clientY: 400 });
  fireEvent.pointerMove(handle, { pointerId, clientX: 600, clientY: 400 + deltaY });
  fireEvent.pointerUp(handle, { pointerId, clientX: 600, clientY: 400 + deltaY });
}

/*
FN-438: the pinned HEADER itself is the primary detach handle, so the gesture is replayed on `.terminal-header`
(optionally starting on a specific descendant, to prove interactive targets are suppressed).
*/
function dragPinnedHeader(deltaY: number, options?: { pointerId?: number; target?: HTMLElement }) {
  const pointerId = options?.pointerId ?? 21;
  const header = screen.getByTestId("terminal-modal").querySelector(".terminal-header") as HTMLElement;
  const target = options?.target ?? header;
  prepareCapture(header);
  fireEvent.pointerDown(target, { pointerId, pointerType: "mouse", button: 0, clientX: 500, clientY: 400 });
  fireEvent.pointerMove(header, { pointerId, pointerType: "mouse", clientX: 500, clientY: 400 + deltaY });
  fireEvent.pointerUp(header, { pointerId, pointerType: "mouse", clientX: 500, clientY: 400 + deltaY });
}

/*
FN-438: the re-pin affordance is the gesture itself (the header button is gone), so every test that used to
click `terminal-popout-toggle` to re-attach now drags the window's bottom edge onto the bottom bar. The travel is
deliberately larger than the viewport so the clamp lands the bottom edge exactly on the contact line.
*/
function repinByFooterContact(panel: HTMLElement, pointerId = 81) {
  const header = panel.querySelector(".terminal-header") as HTMLElement;
  prepareCapture(header);
  fireEvent.pointerDown(header, { pointerId, pointerType: "mouse", button: 0, clientX: 600, clientY: 300 });
  fireEvent.pointerMove(header, { pointerId, pointerType: "mouse", clientX: 600, clientY: 300 + window.innerHeight });
  fireEvent.pointerUp(header, { pointerId, pointerType: "mouse", clientX: 600, clientY: 300 + window.innerHeight });
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

    dragPinnedHandle(4);

    expect(screen.getByTestId("terminal-modal")).toHaveClass("terminal-modal--below");
    expect(storedMode("detach-threshold")).toBe("below");
  });

  /*
  FN-438 symptom 1: dragging the pinned TITLE BAR upward did nothing at all, because only the grip armed the
  gesture. The header must now detach exactly like the grip.
  */
  it("detaches when the pinned header itself is dragged upward", async () => {
    renderTerminal("detach-header");
    await screen.findByTestId("terminal-below-host");

    dragPinnedHeader(-40);

    await waitFor(() => expect(screen.getByTestId("terminal-modal")).toHaveClass("terminal-modal--floating"));
    expect(storedMode("detach-header")).toBe("floating");
  });

  /* (a) The shared 6px click threshold applies to the header too: a 4px press stays a click. */
  it("keeps the terminal pinned for a header drag under the shared click threshold", async () => {
    renderTerminal("detach-header-threshold");
    await screen.findByTestId("terminal-below-host");

    dragPinnedHeader(-4);

    expect(screen.getByTestId("terminal-modal")).toHaveClass("terminal-modal--below");
    expect(storedMode("detach-header-threshold")).toBe("below");
  });

  /* (c) Header controls and tab surfaces keep their own behavior: a press there never detaches. */
  it("never detaches when the header gesture starts on a control or a tab", async () => {
    renderTerminal("detach-header-controls");
    await screen.findByTestId("terminal-below-host");

    dragPinnedHeader(-40, { pointerId: 31, target: screen.getByTestId("terminal-close-btn") });
    expect(storedMode("detach-header-controls")).toBe("below");

    const tabSurface = screen.getByTestId("terminal-modal").querySelector(".terminal-tab") as HTMLElement;
    expect(tabSurface).not.toBeNull();
    dragPinnedHeader(-40, { pointerId: 32, target: tabSurface });
    expect(storedMode("detach-header-controls")).toBe("below");

    expect(screen.getByTestId("terminal-modal")).toHaveClass("terminal-modal--below");
  });

  /*
  FNXC:TerminalLayout 2026-09-16-18:31:
  FN-469 symptom acceptance. Reported: "quand c'est ancré en bas et que je veux la sortir, ça crée un élément centré,
  au lieu de juste sortir la modale et juste la recrop tout en la laissant précisément sous ma souris en poursuivant
  son déplacement". Before FN-469 the detach called `endGesture()` and then swapped presentation, so the floating
  window mounted at the standard CENTRED rectangle and no further pointer event moved anything. The three assertions
  below each fail on that behaviour: the window is not centred, the pointer is inside it, and the SAME pointer id
  keeps dragging it on `window` with no new `pointerdown`.
  */
  it("pulls the pinned terminal out under the pointer and keeps the same gesture moving it", async () => {
    renderTerminal("detach-handoff");
    await screen.findByTestId("terminal-below-host");

    const header = screen.getByTestId("terminal-modal").querySelector(".terminal-header") as HTMLElement;
    // A painted pinned title bar spanning the work area, so the proportional grab point is measurable.
    Object.defineProperty(header, "getBoundingClientRect", {
      configurable: true,
      value: () => domRect({ left: 0, top: 380, right: window.innerWidth, bottom: 416 }),
    });
    prepareCapture(header);

    fireEvent.pointerDown(header, { pointerId: 77, pointerType: "mouse", button: 0, clientX: 1100, clientY: 400 });
    fireEvent.pointerMove(header, { pointerId: 77, pointerType: "mouse", clientX: 1100, clientY: 340 });

    const panel = await screen.findByTestId("floating-window-terminal-detach-handoff");
    await waitFor(() => expect(Number.parseFloat(panel.style.width)).toBeGreaterThan(0));

    const read = () => ({
      left: Number.parseFloat(panel.style.left),
      top: Number.parseFloat(panel.style.top),
      width: Number.parseFloat(panel.style.width),
      height: Number.parseFloat(panel.style.height),
    });
    const placed = read();

    // (1) NOT the centred opening rectangle: the window sits at the proportional grab point under the pointer.
    const centredLeft = (window.innerWidth - placed.width) / 2;
    expect(placed.left).not.toBe(centredLeft);
    // (2) the pointer is inside the panel it just pulled out.
    expect(1100).toBeGreaterThanOrEqual(placed.left);
    expect(1100).toBeLessThanOrEqual(placed.left + placed.width);
    expect(340).toBeGreaterThanOrEqual(placed.top);
    expect(340).toBeLessThanOrEqual(placed.top + placed.height);

    // (3) the gesture continues: no new pointerdown, same pointer id, on window.
    fireEvent.pointerMove(window, { pointerId: 77, pointerType: "mouse", clientX: 1040, clientY: 300 });
    expect(read()).toEqual({ ...placed, left: placed.left - 60, top: placed.top - 40 });
    fireEvent.pointerUp(window, { pointerId: 77, pointerType: "mouse", clientX: 1040, clientY: 300 });

    const settled = read();
    fireEvent.pointerMove(window, { pointerId: 77, pointerType: "mouse", clientX: 900, clientY: 200 });
    expect(read()).toEqual(settled);
    expect(storedMode("detach-handoff")).toBe("floating");
  });

  /* FN-469: the detach threshold is omnidirectional, so a purely LATERAL pull detaches too (it did not before). */
  it("detaches on a purely horizontal pull of the pinned header", async () => {
    renderTerminal("detach-lateral");
    await screen.findByTestId("terminal-below-host");

    const header = screen.getByTestId("terminal-modal").querySelector(".terminal-header") as HTMLElement;
    prepareCapture(header);
    fireEvent.pointerDown(header, { pointerId: 78, pointerType: "mouse", button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(header, { pointerId: 78, pointerType: "mouse", clientX: 560, clientY: 400 });

    await waitFor(() => expect(storedMode("detach-lateral")).toBe("floating"));
    fireEvent.pointerUp(window, { pointerId: 78, pointerType: "mouse", clientX: 560, clientY: 400 });
  });

  /* FN-469 negative controls: neither the embedded terminal nor a phone viewport detaches or hands a gesture over. */
  it("never detaches or hands a gesture over from the embedded or phone presentations", async () => {
    renderTerminal("detach-embedded", { embedded: true });
    await screen.findByTestId("terminal-embedded-host");
    const embeddedHeader = screen.getByTestId("terminal-modal").querySelector(".terminal-header") as HTMLElement;
    prepareCapture(embeddedHeader);
    fireEvent.pointerDown(embeddedHeader, { pointerId: 79, pointerType: "mouse", button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(embeddedHeader, { pointerId: 79, pointerType: "mouse", clientX: 500, clientY: 320 });
    expect(storedMode("detach-embedded")).toBe("below");
    expect(document.body.style.userSelect).toBe("");
    cleanup();

    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 420 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 720 });
    _resetInitialViewportHeight();
    renderTerminal("detach-phone");
    const phoneHeader = await waitFor(() => {
      const node = screen.getByTestId("terminal-modal").querySelector(".terminal-header");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    prepareCapture(phoneHeader);
    fireEvent.pointerDown(phoneHeader, { pointerId: 80, pointerType: "touch", clientX: 200, clientY: 400 });
    fireEvent.pointerMove(phoneHeader, { pointerId: 80, pointerType: "touch", clientX: 200, clientY: 320 });
    expect(storedMode("detach-phone")).toBe("below");
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

    repinByFooterContact(screen.getByTestId("floating-window-terminal-detach-drag"));

    await waitFor(() => expect(screen.getByTestId("terminal-below-host")).toBeInTheDocument());
    await waitFor(() => {
      const element = liveXterm()!.element!;
      expect(element.isConnected).toBe(true);
      expect(screen.getByTestId("terminal-below-host")).toContainElement(element);
    });
    expect(liveXterm()!.refresh.mock.calls.length).toBeGreaterThan(refreshBaseline);
    expect(mockFit.mock.calls.length).toBeGreaterThan(fitBaseline);
  });

  /*
  (d) A real move that stops above the footer line must NOT re-pin. FN-438 asserts the committed rectangle
  genuinely ends clear of the contact line, so this counter-proof cannot pass by accident.
  */
  it("keeps the window detached when the gesture ends above the footer line", async () => {
    renderTerminal("repin-above", { mode: "floating" });
    const panel = await screen.findByTestId("floating-window-terminal-repin-above");
    const header = panel.querySelector(".terminal-header") as HTMLElement;
    prepareCapture(header);

    // Travel upward, away from the bottom bar, but not far enough to arm the top band.
    fireEvent.pointerDown(header, { pointerId: 61, pointerType: "mouse", button: 0, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(header, { pointerId: 61, pointerType: "mouse", clientX: 600, clientY: 360 });
    fireEvent.pointerUp(header, { pointerId: 61, pointerType: "mouse", clientX: 600, clientY: 360 });

    expect(panel.dataset.snapMode).toBe("floating");
    const committedBottom = Number.parseFloat(panel.style.top) + Number.parseFloat(panel.style.height);
    expect(committedBottom).toBeLessThan(window.innerHeight - FOOTER_HEIGHT - 24);
    expect(storedMode("repin-above")).toBe("floating");
    expect(screen.queryByTestId("terminal-below-host")).toBeNull();
  });

  /*
  FNXC:TerminalLayout 2026-09-16-18:31:
  FN-469: the footer-contact re-pin gesture now arms the SHARED bottom band, so the validated payload reports
  `snapMode: "bottom"`. The terminal must still re-pin into its own in-flow `below` presentation; without accepting
  that mode the existing re-pin would silently regress into a generic bottom dock.
  */
  it("re-pins into the below presentation when the gesture arms the shared bottom band", async () => {
    renderTerminal("repin-bottom-band", { mode: "floating" });
    const panel = await screen.findByTestId("floating-window-terminal-repin-bottom-band");
    const header = panel.querySelector(".terminal-header") as HTMLElement;
    prepareCapture(header);

    fireEvent.pointerDown(header, { pointerId: 91, pointerType: "mouse", button: 0, clientX: 600, clientY: 300 });
    fireEvent.pointerMove(header, { pointerId: 91, pointerType: "mouse", clientX: 600, clientY: 300 + window.innerHeight });
    // The band is armed by the panel's own bottom edge resting on the work area's bottom wall.
    expect(screen.getByTestId("floating-window-snap-preview-terminal-repin-bottom-band").dataset.snapZone).toBe("bottom");
    fireEvent.pointerUp(header, { pointerId: 91, pointerType: "mouse", clientX: 600, clientY: 300 + window.innerHeight });

    await waitFor(() => expect(screen.getByTestId("terminal-below-host")).toBeInTheDocument());
    expect(storedMode("repin-bottom-band")).toBe("below");
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

  /*
  FN-438 symptom 2 reproduction. The panel's DOM rectangle is left STALE for the whole gesture (it keeps the
  pre-drag value), and the pending animation frame is never flushed, exactly like a quick real drag where
  `handlePointerUp` cancels the frame before the last move was painted. The retired capture-phase listener
  measured that stale rectangle and refused to re-pin; the validated `onDragGestureEnd` payload re-pins anyway.
  */
  it("re-pins on a fast gesture whose pending frame was never painted", async () => {
    const pendingFrames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    renderTerminal("repin-stale-frame", { mode: "floating" });
    const panel = await screen.findByTestId("floating-window-terminal-repin-stale-frame");

    // The DOM rectangle stays where the window STARTED, for the entire gesture.
    const stale = domRect({ left: 200, top: 100, right: 1000, bottom: 500 });
    panelRect = stale;
    const header = panel.querySelector(".terminal-header") as HTMLElement;
    prepareCapture(header);

    // Travel far enough downward that the committed rect lands on the footer line.
    const paintedTop = Number.parseFloat(panel.style.top);
    const paintedHeight = Number.parseFloat(panel.style.height);
    const footerLine = window.innerHeight - FOOTER_HEIGHT;
    const travel = footerLine - (paintedTop + paintedHeight);

    fireEvent.pointerDown(header, { pointerId: 41, pointerType: "mouse", button: 0, clientX: 600, clientY: 300 });
    fireEvent.pointerMove(header, { pointerId: 41, pointerType: "mouse", clientX: 600, clientY: 300 + travel });
    fireEvent.pointerUp(header, { pointerId: 41, pointerType: "mouse", clientX: 600, clientY: 300 + travel });

    await waitFor(() => expect(storedMode("repin-stale-frame")).toBe("below"));
    expect(screen.getByTestId("terminal-below-host")).toBeInTheDocument();
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

  /*
  (l) A snapped window fills the work area, so its bottom edge rests on the footer line by construction. FN-438
  drives a REAL docking gesture for each anchored mode (the retired implementation read `data-snap-mode` from the
  DOM, which a test could set by hand and which proved nothing about the committed mode).
  */
  it.each([
    { mode: "maximized", to: { x: 700, y: HEADER_HEIGHT + 1 } },
    { mode: "left", to: { x: 4, y: 400 } },
    /*
    FNXC:TerminalWindow 2026-09-16-05:45:
    FN-456 changed the terminal's OPENING width, so a target computed from the viewport no longer lands the
    window's own right edge on the wall. Dragging well past the wall is the documented gesture ("keep dragging
    past the edge"): the position clamp pins the edge exactly on it whatever the window width.
    */
    { mode: "right", to: { x: 5000, y: 400 } },
  ])("stays detached for a $mode-snapped window resting on the footer line", async ({ mode, to }) => {
    const projectId = `repin-snap-${mode}`;
    renderTerminal(projectId, { mode: "floating" });
    const panel = await screen.findByTestId(`floating-window-terminal-${projectId}`);
    const header = panel.querySelector(".terminal-header") as HTMLElement;
    prepareCapture(header);

    fireEvent.pointerDown(header, { pointerId: 51, pointerType: "mouse", button: 0, clientX: 700, clientY: 400 });
    fireEvent.pointerMove(header, { pointerId: 51, pointerType: "mouse", clientX: to.x, clientY: to.y });
    fireEvent.pointerUp(header, { pointerId: 51, pointerType: "mouse", clientX: to.x, clientY: to.y });

    expect(panel.dataset.snapMode).toBe(mode);
    // The anchored rectangle genuinely touches the contact line, so only the snapMode gate keeps it detached.
    expect(Number.parseFloat(panel.style.top) + Number.parseFloat(panel.style.height)).toBe(window.innerHeight - FOOTER_HEIGHT);
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
    // FN-438: no toggle button either — the phone sheet has a single presentation.
    expect(screen.queryByTestId("terminal-popout-toggle")).toBeNull();

    fireEvent.pointerDown(document.body, { pointerId: 3, pointerType: "touch", clientY: 800 });
    fireEvent.pointerUp(document.body, { pointerId: 3, pointerType: "touch", clientY: 890 });
    expect(storedMode("repin-phone")).toBe("floating");

    // FN-438: and dragging the sheet header arms no detach gesture on a phone.
    const header = screen.getByTestId("terminal-modal").querySelector(".terminal-header") as HTMLElement;
    prepareCapture(header);
    fireEvent.pointerDown(header, { pointerId: 4, pointerType: "touch", clientX: 200, clientY: 400 });
    fireEvent.pointerMove(header, { pointerId: 4, pointerType: "touch", clientX: 200, clientY: 300 });
    fireEvent.pointerUp(header, { pointerId: 4, pointerType: "touch", clientX: 200, clientY: 300 });
    expect(storedMode("repin-phone")).toBe("floating");
  });

  /* (g) Embedded: parent-owned layout, so no grip and no display-mode change. */
  it("exposes no detach grip and never changes display mode when embedded", async () => {
    renderTerminal("repin-embedded", { embedded: true });
    await screen.findByTestId("terminal-embedded-host");

    expect(screen.queryByTestId("terminal-pinned-drag-handle")).toBeNull();
    expect(screen.queryByTestId("terminal-below-host")).toBeNull();
    expect(screen.queryByTestId("floating-window-terminal-repin-embedded")).toBeNull();
    // FN-438: no toggle button, and dragging the embedded header never changes the parent-owned presentation.
    expect(screen.queryByTestId("terminal-popout-toggle")).toBeNull();
    const embeddedHeader = screen.getByTestId("terminal-modal").querySelector(".terminal-header") as HTMLElement;
    prepareCapture(embeddedHeader);
    fireEvent.pointerDown(embeddedHeader, { pointerId: 7, pointerType: "mouse", button: 0, clientX: 300, clientY: 400 });
    fireEvent.pointerMove(embeddedHeader, { pointerId: 7, pointerType: "mouse", clientX: 300, clientY: 340 });
    fireEvent.pointerUp(embeddedHeader, { pointerId: 7, pointerType: "mouse", clientX: 300, clientY: 340 });
    expect(storedMode("repin-embedded")).toBe("below");
  });

  /* Tablet replays the desktop gestures: detach, no-contact release, and footer-contact re-pin. */
  describe("tablet viewport", () => {
    beforeEach(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
      _resetInitialViewportHeight();
    });

    it("detaches on a header drag and re-pins only on a footer-contact move gesture", async () => {
      renderTerminal("tablet-gestures");
      await screen.findByTestId("terminal-below-host");

      // FN-438 case (n): the tablet detaches from the header itself, like desktop, and exposes no toggle button.
      expect(screen.queryByTestId("terminal-popout-toggle")).toBeNull();
      dragPinnedHeader(-40, { pointerId: 91 });
      await waitFor(() => expect(storedMode("tablet-gestures")).toBe("floating"));
      const panel = await screen.findByTestId("floating-window-terminal-tablet-gestures");

      /*
      A move that stops short of the footer line stays detached.

      FNXC:TerminalLayout 2026-09-16-18:31:
      FN-469: the window is now pulled out UNDER THE POINTER, so it starts low in the work area. The "stops short"
      gesture therefore has to travel UPWARD to genuinely end clear of the bottom wall; travelling further down is no
      longer a counter-proof, because reaching that wall is exactly what arms the shared bottom band.
      */
      moveFloatingPanel(
        panel,
        domRect({ left: 100, top: 500, right: 900, bottom: 900 }),
        domRect({ left: 100, top: 450, right: 900, bottom: 850 }),
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
