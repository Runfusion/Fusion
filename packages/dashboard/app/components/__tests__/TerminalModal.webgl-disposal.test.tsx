/*
FNXC:Terminal 2026-07-26-18:10:
Guard for the WebGL-context release half of the mobile tab-retention work. `terminal-scrollback-floor.test.ts`
covers the scrollback constants; nothing covered the GL context, which is the other resident-set item
TerminalModal teardown is responsible for.

Requirement: a live xterm holds a WebGL renderer owning a real GL context plus glyph-atlas textures. GL
contexts are a scarce process-wide resource that GC does not release promptly, so an orphaned one keeps
memory pressure high on iOS — and memory pressure is what makes the OS discard the backgrounded tab and
force the white-splash reload. Every teardown path must therefore dispose the ADDON explicitly, before
the terminal, not just call `terminal.dispose()` and trust xterm's AddonManager.

There are five teardown paths (session switch, project switch, modal close, session-invalid swap, manual
reinit) plus unmount. They were once five hand-copied blocks and NONE disposed the WebGL addon, so this
file asserts the property per-path rather than once: the four paths reachable through the public
component surface are driven behaviorally below, and the structural guard at the bottom covers the
remainder by proving no teardown site can bypass the shared `disposeXtermInstance` helper.

Ordering is asserted, not just occurrence: disposing the addon AFTER its terminal is already destroyed is
the shape that silently leaves the context attached.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, waitFor, act } from "@testing-library/react";
import { TerminalModal } from "../TerminalModal";
import * as useTerminalModule from "../../hooks/useTerminal";
import * as useTerminalSessionsModule from "../../hooks/useTerminalSessions";
import * as useWorkspacesModule from "../../hooks/useWorkspaces";

vi.mock("../../hooks/useTerminal", () => ({ useTerminal: vi.fn() }));
vi.mock("../../hooks/useTerminalSessions", () => ({ useTerminalSessions: vi.fn() }));
vi.mock("../../hooks/useWorkspaces", () => ({ useWorkspaces: vi.fn() }));
vi.mock("../../api", () => ({
  createTerminalSession: vi.fn().mockResolvedValue({
    sessionId: "session-a",
    shell: "/bin/bash",
    cwd: "/project",
  }),
  killPtyTerminalSession: vi.fn().mockResolvedValue({ killed: true }),
  listTerminalSessions: vi.fn().mockResolvedValue([]),
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

/** Ordered record of teardown calls, so "addon disposed before terminal" is checkable. */
let teardownLog: string[] = [];
/** Every WebglAddon the component constructed, in creation order. */
let webglAddons: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
/** Every Terminal the component constructed, in creation order. */
let terminals: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];

function createMockTerminal() {
  const index = terminals.length;
  const terminal = {
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ""),
    paste: vi.fn(),
    dispose: vi.fn(() => teardownLog.push(`terminal:${index}`)),
    write: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    refresh: vi.fn(),
    options: { fontFamily: undefined, fontSize: 14, cursorStyle: "block", cursorBlink: true },
    cols: 80,
    rows: 24,
  };
  terminals.push(terminal);
  return terminal;
}

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function TerminalMock() {
    return createMockTerminal();
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
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function WebglAddonMock() {
    const index = webglAddons.length;
    const addon = {
      onContextLoss: vi.fn(),
      dispose: vi.fn(() => teardownLog.push(`webgl:${index}`)),
    };
    webglAddons.push(addon);
    return addon;
  }),
}));

const mockUseTerminal = vi.mocked(useTerminalModule.useTerminal);
const mockUseTerminalSessions = vi.mocked(useTerminalSessionsModule.useTerminalSessions);
const mockUseWorkspaces = vi.mocked(useWorkspacesModule.useWorkspaces);

/** Captured from useTerminal so the session-invalid teardown path can be fired directly. */
let sessionInvalidHandler: (() => void) | null = null;

function tab(sessionId: string) {
  return { id: `tab-${sessionId}`, sessionId, title: "bash", isActive: true, createdAt: 0 };
}

function setActiveSession(sessionId: string): void {
  const activeTab = tab(sessionId);
  mockUseTerminalSessions.mockReturnValue({
    tabs: [activeTab],
    activeTab,
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
  } as never);
}

beforeEach(() => {
  teardownLog = [];
  webglAddons = [];
  terminals = [];
  sessionInvalidHandler = null;
  // Desktop, non-touch: the WebGL addon is skipped outright on mobile viewports.
  Object.defineProperty(window, "innerWidth", { value: 1280, writable: true, configurable: true });
  Object.defineProperty(window, "ontouchstart", { value: undefined, writable: true, configurable: true });
  Object.defineProperty(navigator, "maxTouchPoints", { value: 0, writable: true, configurable: true });
  Object.defineProperty(document, "fonts", { value: undefined, configurable: true });
  window.localStorage.clear();
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as never);
  mockUseTerminal.mockReturnValue({
    connectionStatus: "disconnected",
    sendInput: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onConnect: vi.fn(() => vi.fn()),
    onScrollback: vi.fn(() => vi.fn()),
    reconnect: vi.fn(),
    onSessionInvalid: vi.fn((cb: () => void) => {
      sessionInvalidHandler = cb;
      return vi.fn();
    }),
  } as never);
  mockUseWorkspaces.mockReturnValue({
    projectName: "kb",
    workspaces: [],
    loading: false,
    error: null,
  } as never);
  setActiveSession("session-a");
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Render an open modal and wait until the WebGL addon has actually attached. */
async function renderWithLiveWebgl(props: { projectId?: string } = {}) {
  const view = render(<TerminalModal isOpen onClose={vi.fn()} {...props} />);
  await waitFor(() => {
    expect(
      webglAddons.length,
      "TerminalModal never attached a WebGL addon, so this file cannot prove anything about its disposal. Check the mobile/renderer-preference gate in the init effect before editing the assertions below.",
    ).toBeGreaterThan(0);
  });
  return view;
}

/**
 * The invariant every path shares: the addon at `addonIndex` was disposed, and it was disposed while its
 * terminal was still alive.
 */
function expectGlContextReleasedBeforeTerminal(addonIndex: number, terminalIndex: number, path: string): void {
  const addonAt = teardownLog.indexOf(`webgl:${addonIndex}`);
  const terminalAt = teardownLog.indexOf(`terminal:${terminalIndex}`);
  expect(
    addonAt,
    `WEBGL LEAK — ${path}: the WebGL addon was never disposed. Calling only terminal.dispose() leaves the GL context and its glyph-atlas textures resident; GC does not release GL contexts promptly, and that residency is what gets a backgrounded tab discarded on iOS. Route this teardown through disposeXtermInstance().`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    terminalAt,
    `TERMINAL LEAK — ${path}: the xterm instance (and its multi-thousand-line scrollback ring) was never disposed.`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    addonAt,
    `WEBGL DISPOSE ORDER — ${path}: the addon must be disposed BEFORE its terminal so it can detach from a live renderer. Disposing it after terminal.dispose() is the shape that silently leaves the context attached.`,
  ).toBeLessThan(terminalAt);
}

describe("TerminalModal releases the WebGL context on every teardown path", () => {
  it("modal close", async () => {
    const { rerender } = await renderWithLiveWebgl();

    await act(async () => {
      rerender(<TerminalModal isOpen={false} onClose={vi.fn()} />);
    });

    expectGlContextReleasedBeforeTerminal(0, 0, "modal close");
  });

  it("unmount", async () => {
    const { unmount } = await renderWithLiveWebgl();

    await act(async () => {
      unmount();
    });

    expectGlContextReleasedBeforeTerminal(0, 0, "unmount");
  });

  it("session switch", async () => {
    const { rerender } = await renderWithLiveWebgl();

    setActiveSession("session-b");
    await act(async () => {
      rerender(<TerminalModal isOpen onClose={vi.fn()} />);
    });
    // The switch tears the old instance down and builds a new one.
    await waitFor(() => {
      expect(webglAddons.length).toBeGreaterThan(1);
    });

    expectGlContextReleasedBeforeTerminal(0, 0, "session switch");
  });

  it("project switch", async () => {
    const { rerender } = await renderWithLiveWebgl({ projectId: "proj-1" });

    await act(async () => {
      rerender(<TerminalModal isOpen onClose={vi.fn()} projectId="proj-2" />);
    });
    await waitFor(() => {
      expect(webglAddons.length).toBeGreaterThan(1);
    });

    expectGlContextReleasedBeforeTerminal(0, 0, "project switch");
  });

  it("session-invalid swap", async () => {
    await renderWithLiveWebgl();
    expect(
      sessionInvalidHandler,
      "useTerminal's onSessionInvalid was never subscribed; this path cannot be driven.",
    ).not.toBeNull();

    await act(async () => {
      sessionInvalidHandler?.();
    });

    expectGlContextReleasedBeforeTerminal(0, 0, "session-invalid swap");
  });
});

/*
FNXC:Terminal 2026-07-26-18:15:
Structural backstop for the paths that cannot be driven through the public surface (manual reinit is
behind an init-error affordance) and, more importantly, for paths that do not exist yet. The behavioral
cases above prove today's five sites release the context; they cannot prove the SIXTH one somebody adds
next month does. The enforceable invariant is that `xtermRef` is only ever disposed inside
`disposeXtermInstance`, which is the single place the addon is released — so a new teardown block
physically cannot bypass it.
*/
const TERMINAL_MODAL_PATH = resolve(fileURLToPath(import.meta.url), "../../TerminalModal.tsx");

/**
 * Strip block comments and whole-line `//` comments before counting call sites.
 *
 * FNXC:Terminal 2026-07-26-18:35:
 * Required, not cosmetic: both terminal files document their disposal ordering in FNXC prose that quotes
 * `term.dispose()` verbatim, so a raw text scan finds the COMMENT before the code and reports a false
 * ordering violation (and a false second call site). Same reason the engine's legacy-tombstone guard
 * strips comments first. Only whole-line `//` is removed so a `https://` inside a string is left alone.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("TerminalModal teardown routes through the shared disposer", () => {
  const source = readFileSync(TERMINAL_MODAL_PATH, "utf8");

  it("disposes the WebGL addon before the terminal inside disposeXtermInstance", () => {
    const helper = /const disposeXtermInstance = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[\]\);/.exec(source);
    expect(
      helper,
      `webgl-disposal: could not locate \`disposeXtermInstance\` in ${TERMINAL_MODAL_PATH}. It was renamed or restructured — re-point this guard rather than deleting it; it is the only thing preventing a new teardown path from leaking a GL context.`,
    ).not.toBeNull();
    const body = helper![1];
    const webglAt = body.indexOf("webglAddonRef.current.dispose()");
    const terminalAt = body.indexOf("xtermRef.current.dispose()");
    expect(webglAt, "disposeXtermInstance no longer disposes the WebGL addon.").toBeGreaterThanOrEqual(0);
    expect(terminalAt, "disposeXtermInstance no longer disposes the terminal.").toBeGreaterThanOrEqual(0);
    expect(
      webglAt,
      "disposeXtermInstance must dispose the WebGL addon BEFORE the terminal, so the addon detaches from a live renderer.",
    ).toBeLessThan(terminalAt);
    expect(body, "disposeXtermInstance must null the addon ref so a stale addon is never re-disposed.").toContain(
      "webglAddonRef.current = null",
    );
  });

  it("has no teardown site that disposes the terminal outside the shared disposer", () => {
    const occurrences = stripComments(source).split("xtermRef.current.dispose()").length - 1;
    expect(
      occurrences,
      `WEBGL LEAK RISK: \`xtermRef.current.dispose()\` appears ${occurrences} times in ${TERMINAL_MODAL_PATH}, but it must appear exactly once — inside disposeXtermInstance. A second call site is a teardown path that destroys the terminal without releasing its GL context, which is exactly the drift (four hand-copied blocks, none disposing WebGL) this helper was introduced to end. Call disposeXtermInstance() instead.`,
    ).toBe(1);
  });

  /*
  FNXC:Terminal 2026-07-26-18:25:
  Sibling surface. SessionTerminal is the second xterm host and holds its own GL context; its teardown is
  the init effect's cleanup (deps: sessionId, readOnly, mode, projectId), so session switch, mode switch,
  project switch, and unmount all funnel through that one block. It is guarded structurally here rather
  than behaviorally because there is exactly one site and the failure mode is a future edit that reorders
  or drops the addon dispose — not a missing call path.
  */
  it("SessionTerminal disposes its WebGL addon before its terminal in the only teardown block", () => {
    const sessionTerminalPath = resolve(fileURLToPath(import.meta.url), "../../SessionTerminal.tsx");
    const sessionSource = stripComments(readFileSync(sessionTerminalPath, "utf8"));
    const webglAt = sessionSource.indexOf("webglAddonRef.current.dispose()");
    expect(
      webglAt,
      `WEBGL LEAK — ${sessionTerminalPath}: the CLI-agent session terminal no longer disposes its WebGL addon on teardown. Its GL context then outlives the session, which is the iOS memory-pressure source that gets the backgrounded tab discarded.`,
    ).toBeGreaterThanOrEqual(0);
    const termDisposeAt = sessionSource.indexOf("term.dispose()");
    expect(termDisposeAt, "SessionTerminal no longer disposes its terminal on teardown.").toBeGreaterThanOrEqual(0);
    expect(
      webglAt,
      "SessionTerminal must dispose the WebGL addon BEFORE the terminal, so the addon detaches from a live renderer.",
    ).toBeLessThan(termDisposeAt);
    expect(
      sessionSource.split("term.dispose()").length - 1,
      "SessionTerminal must have exactly one terminal-teardown site; a second one is a path that can destroy the terminal without releasing its GL context.",
    ).toBe(1);
  });

  it("keeps every teardown path wired to the disposer", () => {
    // Session/project switch, modal close, session-invalid swap, manual reinit, unmount.
    const callSites = stripComments(source).split("disposeXtermInstance()").length - 1;
    expect(
      callSites,
      `webgl-disposal: expected at least the five known teardown call sites plus unmount to call disposeXtermInstance(); found ${callSites}. If a path was removed, remove its behavioral case above too rather than lowering this number silently.`,
    ).toBeGreaterThanOrEqual(5);
  });
});
