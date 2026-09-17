/*
FNXC:TerminalLayout 2026-09-17-05:20:
FN-488 symptom acceptance, proven on the real `TerminalModal`.

Reported symptom: « Le terminal ancré en bas ne doit pas être bloqué dans un z-index inférieur aux modales. Il doit se
comporter exactement comme les autres modales », c'est-à-dire que la dernière surface ouverte ou engagée passe devant,
peu importe l'ancrage. Before the fix the pinned root carried NO inline z-index at all, so every window in the shared
10100+ band painted over it and no click on the terminal could invert that order.

The invariant asserted here is the general one, not the single reported case: the pinned panel is a full peer of the
shared `floatingWindowStack` counter — it wins when engaged last and loses when another window is engaged after it,
across mount order, several windows, a presentation round-trip, and the focus-restoration fence — while the mobile
sheet, the embedded host, and the detached (FloatingWindow-owned) presentation deliberately claim nothing.

jsdom reports a zero rectangle for every element, so the detach/re-pin round-trip installs explicit landmark
rectangles exactly like `TerminalModal.pinned-detach-repin.test.tsx`, whose mount harness this file reuses.
*/
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  DashboardWindowManagerProvider,
  useDashboardWindowLandmark,
  useDashboardWindowVisibility,
} from "../../context/DashboardWindowManagerContext";
import { readAppFile } from "../../test/cssFixture";
import { FloatingWindow } from "../FloatingWindow";
import { currentFloatingZ } from "../floatingWindowStack";
import { TerminalModal, _resetInitialViewportHeight } from "../TerminalModal";

const HEADER_HEIGHT = 64;
const FOOTER_HEIGHT = 36;
/** Base of the shared floating band (`floatingWindowStack.ts`); every claim must sit above it. */
const FLOATING_BAND_BASE = 10100;

vi.mock("../../hooks/useTerminal", () => ({ useTerminal: vi.fn() }));
vi.mock("../../hooks/useTerminalSessions", () => ({ useTerminalSessions: vi.fn() }));
vi.mock("../../hooks/useWorkspaces", () => ({ useWorkspaces: vi.fn() }));
vi.mock("../../api", () => ({
  createTerminalSession: vi.fn(),
  killPtyTerminalSession: vi.fn(),
  listTerminalSessions: vi.fn().mockResolvedValue([]),
}));

interface MockXterm {
  element: HTMLElement | null;
  open: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

let mockXtermInstances: MockXterm[] = [];
const mockFit = vi.fn();

function createMockXterm(): MockXterm {
  const instance: MockXterm = {
    element: null,
    open: vi.fn((container: HTMLElement) => {
      const element = document.createElement("div");
      element.className = "xterm";
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
  return {
    ...value,
    width: value.right - value.left,
    height: value.bottom - value.top,
    x: value.left,
    y: value.top,
    toJSON: () => ({}),
  } as DOMRect;
}

const ZERO_RECT = domRect({ left: 0, top: 0, right: 0, bottom: 0 });

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

/** Minimal stand-in for `DashboardWindowVisibilityToggle`'s only behaviour this file needs. */
function VisibilityToggle() {
  const controller = useDashboardWindowVisibility();
  return (
    <button type="button" data-testid="visibility-toggle" onClick={() => controller?.toggleVisibility()}>
      toggle
    </button>
  );
}

function utilityWindow(key: string) {
  return (
    <FloatingWindow windowKey={key} title={key} onClose={() => {}}>
      <div>{key} body</div>
    </FloatingWindow>
  );
}

function renderPinnedTerminal(
  projectId: string,
  options?: { mode?: "below" | "floating"; embedded?: boolean; before?: ReactNode; after?: ReactNode; focusNonce?: number },
) {
  window.localStorage.setItem(`fusion:terminal-display-mode-${projectId}`, options?.mode ?? "below");
  const tree = (props: { focusNonce?: number }) => (
    <DashboardWindowManagerProvider>
      <Landmarks />
      <VisibilityToggle />
      {options?.before}
      <TerminalModal
        isOpen={true}
        onClose={() => {}}
        projectId={projectId}
        footerVisible={true}
        embedded={options?.embedded}
        focusNonce={props.focusNonce}
      />
      {options?.after}
    </DashboardWindowManagerProvider>
  );
  const result = render(tree({ focusNonce: options?.focusNonce }));
  return {
    ...result,
    setFocusNonce: (focusNonce: number) => result.rerender(tree({ focusNonce })),
  };
}

function terminalRoot(): HTMLElement {
  return screen.getByTestId("terminal-modal");
}

function windowPanel(key: string): HTMLElement {
  return screen.getByTestId(`floating-window-${key}`);
}

function z(element: HTMLElement): number {
  return Number(element.style.zIndex);
}

function prepareCapture(target: HTMLElement) {
  Object.defineProperty(target, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(target, "releasePointerCapture", { configurable: true, value: vi.fn() });
}

/** Detaches the pinned terminal by dragging its grip past the detach threshold. */
function detachPinnedTerminal(pointerId = 11) {
  const handle = screen.getByTestId("terminal-pinned-drag-handle");
  prepareCapture(handle);
  fireEvent.pointerDown(handle, { pointerId, clientX: 600, clientY: 400 });
  fireEvent.pointerMove(handle, { pointerId, clientX: 600, clientY: 200 });
  fireEvent.pointerUp(handle, { pointerId, clientX: 600, clientY: 200 });
}

/** Re-pins the detached terminal by landing its bottom edge on the footer contact line. */
function repinTerminal(panel: HTMLElement, pointerId = 12) {
  const header = panel.querySelector(".terminal-header") as HTMLElement;
  prepareCapture(header);
  fireEvent.pointerDown(header, { pointerId, pointerType: "mouse", button: 0, clientX: 600, clientY: 300 });
  fireEvent.pointerMove(header, { pointerId, pointerType: "mouse", clientX: 600, clientY: 300 + window.innerHeight });
  fireEvent.pointerUp(header, { pointerId, pointerType: "mouse", clientX: 600, clientY: 300 + window.innerHeight });
}

function mockMatchMedia(matcher: (query: string) => boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: matcher(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

/** Frames captured instead of run, so the focus-restoration fence can be observed while it is open. */
let pendingFrames: FrameRequestCallback[] = [];

function flushFrames() {
  const frames = pendingFrames;
  pendingFrames = [];
  act(() => {
    for (const frame of frames) frame(0);
  });
}

describe("pinned terminal shared-stack participation", () => {
  beforeEach(() => {
    localStorage.clear();
    mockXtermInstances = [];
    mockFit.mockClear();
    pendingFrames = [];
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
    mockMatchMedia(() => false);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const name = this.dataset.landmark;
      if (name === "header") return domRect({ left: 0, top: 0, right: window.innerWidth, bottom: HEADER_HEIGHT });
      if (name === "footer") {
        return domRect({ left: 0, top: window.innerHeight - FOOTER_HEIGHT, right: window.innerWidth, bottom: window.innerHeight });
      }
      return ZERO_RECT;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetInitialViewportHeight();
  });

  /* (a) A pinned terminal mounted alone still claims a real value from the shared band. */
  it("claims a shared-band z-index as soon as it is pinned, with no other window open", () => {
    renderPinnedTerminal("alone");

    const panel = terminalRoot();
    expect(panel).toHaveClass("terminal-modal--below");
    expect(panel.style.zIndex).not.toBe("");
    expect(z(panel)).toBeGreaterThan(FLOATING_BAND_BASE);
    expect(z(panel)).toBe(currentFloatingZ());
  });

  /* (a, tablet) The tablet presentation runs the same branch and must claim identically. */
  it("claims the same shared-band z-index on a tablet viewport", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 900 });
    mockMatchMedia((query) => query === "(min-width: 769px) and (max-width: 1023.98px)");

    renderPinnedTerminal("tablet");

    const panel = terminalRoot();
    expect(panel).toHaveClass("terminal-modal--tablet");
    expect(panel).toHaveClass("terminal-modal--below");
    expect(z(panel)).toBeGreaterThan(FLOATING_BAND_BASE);
  });

  /* (b) A window opened BEFORE the pinned terminal must end up behind it. */
  it("paints above a window that was already open when it mounted", () => {
    renderPinnedTerminal("mounted-after", { before: utilityWindow("earlier") });

    expect(z(terminalRoot())).toBeGreaterThan(z(windowPanel("earlier")));
  });

  /*
  (c) SYMPTOM: a window opened AFTER the pinned terminal is in front (correct), but before this fix NO interaction
  could ever invert that order — the pinned root had no inline z-index at all.
  */
  it("raises above a window opened after it when engaged, and yields again when that window is engaged", () => {
    renderPinnedTerminal("symptom", { after: utilityWindow("later") });

    const panel = terminalRoot();
    const later = windowPanel("later");

    // The reported starting state: the later window is in front — and the pinned panel is now a real competitor.
    expect(panel.style.zIndex).not.toBe("");
    expect(z(later)).toBeGreaterThan(z(panel));

    // Engaging the pinned terminal brings it strictly in front: this is the assertion the symptom failed.
    fireEvent.pointerDown(panel);
    expect(z(panel)).toBeGreaterThan(z(later));

    // Engaging the window again inverts the order once more, so the rule really is "last engaged wins".
    fireEvent.focus(later);
    expect(z(later)).toBeGreaterThan(z(panel));
  });

  /* (d) With several windows the order follows the last engaged surface, in both directions. */
  it("interleaves with several windows by interaction order", () => {
    renderPinnedTerminal("many", { before: utilityWindow("w1"), after: <>{utilityWindow("w2")}{utilityWindow("w3")}</> });

    const panel = terminalRoot();
    const w1 = windowPanel("w1");
    const w2 = windowPanel("w2");
    const w3 = windowPanel("w3");

    expect(z(w3)).toBeGreaterThan(z(w2));
    expect(z(w2)).toBeGreaterThan(z(panel));
    expect(z(panel)).toBeGreaterThan(z(w1));

    fireEvent.pointerDown(panel);
    for (const other of [w1, w2, w3]) expect(z(panel)).toBeGreaterThan(z(other));

    fireEvent.pointerDown(w1);
    expect(z(w1)).toBeGreaterThan(z(panel));

    fireEvent.pointerDown(panel);
    expect(z(panel)).toBeGreaterThan(z(w1));
  });

  /* (d bis) The `focusNonce` refresh signal re-raises a pinned terminal its owner re-opens in place. */
  it("re-raises on the focusNonce signal without remounting", () => {
    const { setFocusNonce } = renderPinnedTerminal("nonce", { after: utilityWindow("other"), focusNonce: 1 });

    const panel = terminalRoot();
    expect(z(windowPanel("other"))).toBeGreaterThan(z(panel));

    setFocusNonce(2);
    expect(z(terminalRoot())).toBeGreaterThan(z(windowPanel("other")));
  });

  /*
  (e) The window manager's focus-restoration fence must suspend focus-to-front, exactly as it does for
  FloatingWindow: a restoration focus is presentational and must preserve the pre-hide order.
  */
  it("does not claim a new layer while the window manager is restoring focus, but does after it settles", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    });

    renderPinnedTerminal("restoring", { after: utilityWindow("peer") });
    const toggle = screen.getByTestId("visibility-toggle");

    fireEvent.click(toggle); // hide all managed windows
    flushFrames();
    fireEvent.click(toggle); // restore: the fence opens synchronously and closes on the next frame

    const duringRestore = z(terminalRoot());
    fireEvent.focus(terminalRoot());
    expect(z(terminalRoot())).toBe(duringRestore);

    flushFrames(); // fence closes
    fireEvent.pointerDown(terminalRoot());
    expect(z(terminalRoot())).toBeGreaterThan(duringRestore);
    expect(z(terminalRoot())).toBeGreaterThan(z(windowPanel("peer")));
  });

  /* (f) No counter churn: re-engaging a terminal that is already on top must not claim a new value. */
  it("does not claim a new layer when it is already on top", () => {
    renderPinnedTerminal("no-churn", { after: utilityWindow("peer") });

    const panel = terminalRoot();
    fireEvent.pointerDown(panel);
    const raised = z(panel);

    fireEvent.pointerDown(panel);
    fireEvent.focus(panel);
    expect(z(terminalRoot())).toBe(raised);
    expect(raised).toBe(currentFloatingZ());
  });

  /*
  (g) Presentation round-trip: pinned → detached → pinned. Returning to the pinned presentation must claim a FRESH
  value, so a window opened while the terminal was detached does not stay permanently in front of it.
  */
  it("claims a fresh layer each time it returns to the pinned presentation", () => {
    renderPinnedTerminal("roundtrip");
    const pinnedZ = z(terminalRoot());

    detachPinnedTerminal();
    const detached = screen.getByTestId("terminal-modal");
    expect(detached).toHaveClass("terminal-modal--floating");
    // FloatingWindow owns the claim while detached: the inner panel must not carry one of its own.
    expect(detached.style.zIndex).toBe("");

    const floatingPanel = screen.getByTestId("terminal-modal-overlay");
    repinTerminal(floatingPanel);

    const repinned = terminalRoot();
    expect(repinned).toHaveClass("terminal-modal--below");
    expect(z(repinned)).toBeGreaterThan(pinnedZ);
    expect(z(repinned)).toBe(currentFloatingZ());
  });

  /* (h) Negative control — the embedded host is parent-owned chrome and claims nothing. */
  it("claims nothing in the embedded presentation", () => {
    renderPinnedTerminal("embedded", { embedded: true, after: utilityWindow("peer") });

    const panel = terminalRoot();
    expect(panel).toHaveClass("terminal-modal--embedded");
    expect(panel.style.zIndex).toBe("");

    const before = currentFloatingZ();
    fireEvent.pointerDown(panel);
    fireEvent.focus(panel);
    expect(panel.style.zIndex).toBe("");
    expect(currentFloatingZ()).toBe(before);
  });

  /* (h) Negative control — the mobile sheet never reaches the pinned branch, so it claims nothing either. */
  it("claims nothing in the mobile sheet presentation", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 500 });
    mockMatchMedia((query) => query.includes("max-width: 768px") || query.includes("max-width: 767.98px") || query.includes("max-width: 600px"));

    renderPinnedTerminal("mobile");

    const panel = terminalRoot();
    expect(panel).toHaveClass("terminal-modal--mobile");
    expect(panel).not.toHaveClass("terminal-modal--below");
    expect(panel.style.zIndex).toBe("");

    const before = currentFloatingZ();
    fireEvent.pointerDown(panel);
    expect(panel.style.zIndex).toBe("");
    expect(currentFloatingZ()).toBe(before);
  });

  /*
  (h) Negative control — in the detached presentation FloatingWindow already owns pointerdown/focus raising. A
  duplicate handler on the inner panel would claim the shared counter twice for a single interaction and would be
  observable as an inline z-index on that inner root.
  */
  it("does not duplicate the raise handlers inside the detached presentation", () => {
    renderPinnedTerminal("detached", { mode: "floating", after: utilityWindow("peer") });

    const inner = terminalRoot();
    const floatingPanel = screen.getByTestId("terminal-modal-overlay");
    expect(inner).toHaveClass("terminal-modal--floating");
    expect(inner.style.zIndex).toBe("");

    fireEvent.pointerDown(inner);
    // Exactly one claim reached the shared counter, and it landed on the FloatingWindow panel.
    expect(inner.style.zIndex).toBe("");
    expect(z(floatingPanel)).toBe(currentFloatingZ());
    expect(z(floatingPanel)).toBeGreaterThan(z(windowPanel("peer")));
  });

  /*
  (i) The pinned terminal is an in-flow panel, not a surface registered with the window manager, so a global
  hide/restore leaves it visible and leaves its layer untouched.
  */
  it("stays visible and keeps its layer across a global window hide and restore", () => {
    renderPinnedTerminal("global-hide", { after: utilityWindow("peer") });

    const before = z(terminalRoot());
    const toggle = screen.getByTestId("visibility-toggle");

    fireEvent.click(toggle);
    expect(screen.getByTestId("terminal-below-host")).toBeInTheDocument();
    expect(z(terminalRoot())).toBe(before);

    fireEvent.click(toggle);
    expect(z(terminalRoot())).toBe(before);
  });

  /*
  (j) Structural invariant, same shape as the DesktopActionBar footer-ancestor guard: the in-flow host must stay
  free of any stacking context, or the panel's shared-band z-index is trapped below its siblings in the root
  context — and the host's own background would be lifted over the fixed bottom bars whose height it reserves.
  */
  it("keeps the pinned host free of any stacking context", () => {
    const css = readAppFile("components/TerminalModal.css");
    const rule = css.match(/\n\.terminal-below-host\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(rule, ".terminal-below-host rule must exist").toBeTruthy();
    const declarations = (rule ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const property of ["z-index", "transform", "filter", "contain", "isolation"]) {
      expect(declarations, `.terminal-below-host must not declare ${property}`).not.toMatch(
        new RegExp(`(^|[;{\\s])${property}\\s*:`),
      );
    }

    // The panel itself is positioned, which is what makes the inline z-index effective without a portal.
    const panelRule = css.match(/\.modal\.terminal-modal\.terminal-modal--below\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(panelRule).toMatch(/position:\s*relative/);
  });

  /*
  (k) FN-488 follow-up: the workspace picker menu is portaled to `document.body`, so a static layer (5000) would now
  paint BEHIND the pinned panel's shared-band claim and make workspace selection unusable while pinned. Its layer
  must be derived from the panel claim in the pinned presentation too, not only in the detached one.
  */
  it("keeps the workspace picker menu above the pinned panel and every other window", () => {
    vi.mocked(useWorkspaces).mockReturnValue({
      projectName: "kb",
      workspaces: [{ id: "ws-1", label: "FN-1", title: "FN-1 task", worktree: "/tmp/fn-1" }],
      loading: false,
      error: null,
    } as unknown as ReturnType<typeof useWorkspaces>);

    renderPinnedTerminal("picker-pinned", { after: utilityWindow("peer") });

    const panel = terminalRoot();
    fireEvent.pointerDown(panel);
    expect(z(panel)).toBeGreaterThan(z(windowPanel("peer")));

    fireEvent.click(screen.getByTestId("terminal-workspace-picker").querySelector(".terminal-workspace-picker-trigger") as HTMLElement);
    const menu = document.getElementById("terminal-workspace-picker-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.style.zIndex).not.toBe("");
    expect(z(menu)).toBeGreaterThan(z(panel));
    expect(z(menu)).toBeGreaterThan(z(windowPanel("peer")));
  });

  /*
  (k, detached) The detached presentation keeps its pre-existing contract: the menu still sits one layer above the
  live ceiling owned by FloatingWindow.
  */
  it("keeps the workspace picker menu above the detached terminal window", () => {
    vi.mocked(useWorkspaces).mockReturnValue({
      projectName: "kb",
      workspaces: [{ id: "ws-1", label: "FN-1", title: "FN-1 task", worktree: "/tmp/fn-1" }],
      loading: false,
      error: null,
    } as unknown as ReturnType<typeof useWorkspaces>);

    renderPinnedTerminal("picker-detached", { mode: "floating" });

    const floatingPanel = screen.getByTestId("terminal-modal-overlay");
    fireEvent.click(screen.getByTestId("terminal-workspace-picker").querySelector(".terminal-workspace-picker-trigger") as HTMLElement);
    const menu = document.getElementById("terminal-workspace-picker-menu") as HTMLElement;
    expect(z(menu)).toBeGreaterThan(z(floatingPanel));
  });

  /*
  (l) FN-488 follow-up: the footer stat tooltip is portaled to `document.body` and painted in the very band the
  pinned panel now occupies, so a fixed `--z-popover` (60) would hide it whenever the terminal is pinned. Like the
  DesktopActionBar open menu and the usage popover, it must follow the live `--fusion-max-z` ceiling.
  */
  it("keeps the footer stat tooltip above the shared window band", () => {
    const css = readAppFile("components/ExecutorStatusBar.css");
    const rule = css.match(/\.executor-status-bar__stat-tooltip\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(rule, ".executor-status-bar__stat-tooltip rule must exist").toBeTruthy();
    expect(rule).toMatch(/z-index:\s*calc\(var\(--fusion-max-z/);
    expect(rule).not.toMatch(/z-index:\s*var\(--z-popover/);
  });
});
