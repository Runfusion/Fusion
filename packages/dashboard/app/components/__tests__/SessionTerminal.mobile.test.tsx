import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";
import { MOBILE_MEDIA_QUERY } from "../../hooks/useViewportMode";

// ── Mock xterm + addon dynamic imports (jsdom has no canvas/WebGL) ──────────
const mockFitAddon = { fit: vi.fn() };
const mockTerm = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(),
  attachCustomKeyEventHandler: vi.fn(),
  hasSelection: vi.fn(() => false),
  getSelection: vi.fn(() => ""),
  write: vi.fn((_data: string, cb?: () => void) => cb?.()),
  dispose: vi.fn(),
  unicode: { activeVersion: "6" },
  options: {} as Record<string, unknown>,
  cols: 80,
  rows: 24,
};
vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn(function Terminal(options) { mockTerm.options = { ...options }; return mockTerm; }) }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn(function FitAddon() { return mockFitAddon; }) }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: vi.fn(function Unicode11Addon() { return {}; }) }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function WebglAddon() { return { onContextLoss: vi.fn(), dispose: vi.fn() }; }),
}));

const apiMock = vi.fn();
vi.mock("../../api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));
vi.mock("../../auth", () => ({ appendTokenQuery: (u: string) => u }));
const terminalPreferenceMocks = vi.hoisted(() => ({
  waitForTerminalFontMetrics: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../../utils/terminalPreferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/terminalPreferences")>();
  return {
    ...actual,
    waitForTerminalFontMetrics: terminalPreferenceMocks.waitForTerminalFontMetrics,
  };
});

// ── Minimal WebSocket stub ──────────────────────────────────────────────────
class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
}
let originalWebSocket: typeof WebSocket | undefined;
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  disconnect() {}
};

// ── matchMedia mock: drive the mobile breakpoint convention ─────────────────
const MOBILE_WIDTH_MEDIA_QUERY = "(max-width: 768px)";
const MOBILE_HEIGHT_MEDIA_QUERY = "(max-height: 480px)";
const originalScreenDescriptor = Object.getOwnPropertyDescriptor(window, "screen");
type MatchMediaState = boolean | { width: boolean; height: boolean };
let matchMediaState: MatchMediaState = true;
function installMatchMedia(state: MatchMediaState) {
  matchMediaState = state;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => {
      const matches = typeof matchMediaState === "boolean"
        ? matchMediaState
        : query === MOBILE_MEDIA_QUERY
          ? matchMediaState.width || matchMediaState.height
          : query === MOBILE_WIDTH_MEDIA_QUERY
            ? matchMediaState.width
            : query === MOBILE_HEIGHT_MEDIA_QUERY
              ? matchMediaState.height
              : false;
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

function stubScreen(width: number, height: number) {
  Object.defineProperty(window, "screen", { configurable: true, value: { width, height } });
}

import { SessionTerminal } from "../SessionTerminal";
import {
  DEFAULT_TERMINAL_PREFERENCES,
  TERMINAL_PREFERENCES_KEY,
  TERMINAL_SYMBOLS_FONT_FAMILY,
} from "../../utils/terminalPreferences";

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

/** Pull the parsed input frames a WS has sent. */
function inputFrames(ws: FakeWS): string[] {
  return ws.sent
    .map((raw) => JSON.parse(raw))
    .filter((m) => m.type === "input")
    .map((m) => m.data as string);
}

/** Render and wait for the WS attach channel to open. */
async function renderMobile(props: Record<string, unknown> = {}) {
  const utils = render(<SessionTerminal sessionId="s1" {...props} />);
  await waitFor(() => expect(FakeWS.instances.length).toBe(1));
  return { ...utils, ws: FakeWS.instances[0] };
}

beforeEach(() => {
  FakeWS.instances = [];
  originalWebSocket = (globalThis as typeof globalThis & { WebSocket?: typeof WebSocket }).WebSocket;
  (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
  window.localStorage.clear();
  mockTerm.loadAddon.mockClear();
  mockTerm.open.mockClear();
  mockTerm.onData.mockReset();
  mockTerm.attachCustomKeyEventHandler.mockClear();
  mockTerm.hasSelection.mockReturnValue(false);
  mockTerm.getSelection.mockReturnValue("");
  mockTerm.write.mockClear();
  mockTerm.dispose.mockClear();
  mockTerm.options = {};
  mockFitAddon.fit.mockClear();
  terminalPreferenceMocks.waitForTerminalFontMetrics.mockReset();
  terminalPreferenceMocks.waitForTerminalFontMetrics.mockResolvedValue(true);
  apiMock.mockReset();
  apiMock.mockResolvedValue({ ticket: "tkt-1", expiresAt: "", readOnly: false });
  installMatchMedia(true); // mobile by default
  stubScreen(390, 844);
  _resetInitialViewportHeight();
});

afterEach(() => {
  (globalThis as typeof globalThis & { WebSocket?: typeof WebSocket }).WebSocket = originalWebSocket;
  if (originalScreenDescriptor) {
    Object.defineProperty(window, "screen", originalScreenDescriptor);
  }
  vi.clearAllMocks();
});

describe("SessionTerminal (mobile)", () => {
  it("renders the mobile input bar + accessory key bar on mobile viewports", async () => {
    await renderMobile();
    expect(screen.getByTestId("cli-terminal-mobile-bar")).toBeTruthy();
    expect(screen.getByTestId("cli-terminal-key-bar")).toBeTruthy();
    expect(screen.getByTestId("cli-terminal-mobile-input")).toBeTruthy();
  });

  it("uses touch visualViewport width for Android folded initial mobile mode", async () => {
    installMatchMedia({ width: false, height: false });
    const originalVisualViewport = window.visualViewport;
    const originalMaxTouchPoints = navigator.maxTouchPoints;
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 1 });
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 900 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 700 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      writable: true,
      value: {
        width: 390,
        height: 320,
        offsetTop: 0,
        offsetLeft: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    try {
      await renderMobile();
      expect(screen.getByTestId("cli-terminal-mobile-bar")).toBeTruthy();
      expect(screen.getByTestId("cli-terminal-key-bar")).toBeTruthy();
      expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, writable: true, value: originalVisualViewport });
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: originalMaxTouchPoints });
    }
  });

  it("does not render the mobile bar off-mobile (desktop breakpoint)", async () => {
    installMatchMedia(false);
    await renderMobile();
    expect(screen.queryByTestId("cli-terminal-mobile-bar")).toBeNull();
  });

  it("does not render the mobile bar when a tablet-class screen only matches the short-height clause", async () => {
    stubScreen(1024, 768);
    installMatchMedia({ width: false, height: true });
    await renderMobile();
    expect(screen.queryByTestId("cli-terminal-mobile-bar")).toBeNull();
  });

  it.each([
    ["read-only", { readOnly: true }],
    ["idle", { mode: "idle" as const }],
    ["ended", { mode: "ended" as const }],
  ])("does not render the mobile bar when %s", async (_label, props) => {
    if (props.readOnly) {
      apiMock.mockResolvedValue({ ticket: "tkt-1", expiresAt: "", readOnly: true });
    }
    await renderMobile(props);
    expect(screen.queryByTestId("cli-terminal-mobile-bar")).toBeNull();
  });

  it("does not render mobile controls when the attach ticket is read-only", async () => {
    apiMock.mockResolvedValue({ ticket: "tkt-ro", expiresAt: "", readOnly: true });

    await renderMobile();

    expect(screen.queryByTestId("cli-terminal-mobile-bar")).toBeNull();
    expect(mockTerm.options.disableStdin).toBe(true);
    expect(mockTerm.onData).not.toHaveBeenCalled();
  });

  // ── Accessory bar control sequences ───────────────────────────────────────
  it("Esc key emits 0x1b as an input frame", async () => {
    const { ws } = await renderMobile();
    fireEvent.click(screen.getByTestId("cli-key-esc"));
    expect(inputFrames(ws)).toContain("\x1b");
  });

  it("Tab key emits 0x09", async () => {
    const { ws } = await renderMobile();
    fireEvent.click(screen.getByTestId("cli-key-tab"));
    expect(inputFrames(ws)).toContain("\x09");
  });

  it("dedicated Ctrl-C shortcut emits 0x03", async () => {
    const { ws } = await renderMobile();
    fireEvent.click(screen.getByTestId("cli-key-ctrl-c"));
    expect(inputFrames(ws)).toContain("\x03");
  });

  it("arrow keys emit ANSI CSI cursor sequences", async () => {
    const { ws } = await renderMobile();
    fireEvent.click(screen.getByTestId("cli-key-arrow-up"));
    fireEvent.click(screen.getByTestId("cli-key-arrow-down"));
    fireEvent.click(screen.getByTestId("cli-key-arrow-right"));
    fireEvent.click(screen.getByTestId("cli-key-arrow-left"));
    const frames = inputFrames(ws);
    expect(frames).toContain("\x1b[A");
    expect(frames).toContain("\x1b[B");
    expect(frames).toContain("\x1b[C");
    expect(frames).toContain("\x1b[D");
  });

  // ── Sticky Ctrl modifier ──────────────────────────────────────────────────
  it("sticky Ctrl shows an active visual state", async () => {
    await renderMobile();
    const ctrl = screen.getByTestId("cli-key-ctrl");
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(ctrl);
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    expect(ctrl.className).toContain("cli-terminal-key--active");

    // Tapping again toggles it back off.
    fireEvent.click(ctrl);
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
  });

  it("sticky Ctrl + c → 0x03, + d → 0x04, + z → 0x1a (combined, swallowed from field)", async () => {
    const { ws } = await renderMobile();
    const ctrl = screen.getByTestId("cli-key-ctrl");
    const input = screen.getByTestId("cli-terminal-mobile-input") as HTMLInputElement;

    // Ctrl + c
    fireEvent.click(ctrl);
    fireEvent.change(input, { target: { value: "c" } });
    expect(input.value).toBe(""); // combined, not echoed
    expect(ctrl.getAttribute("aria-pressed")).toBe("false"); // cleared

    // Ctrl + d
    fireEvent.click(ctrl);
    fireEvent.change(input, { target: { value: "d" } });

    // Ctrl + z
    fireEvent.click(ctrl);
    fireEvent.change(input, { target: { value: "z" } });

    const frames = inputFrames(ws);
    expect(frames).toContain("\x03"); // Ctrl-C
    expect(frames).toContain("\x04"); // Ctrl-D
    expect(frames).toContain("\x1a"); // Ctrl-Z
  });

  it("without sticky Ctrl, typed letters land in the field (no combine)", async () => {
    await renderMobile();
    const input = screen.getByTestId("cli-terminal-mobile-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "d" } });
    expect(input.value).toBe("d");
  });

  it("sticky Ctrl + arrow does not combine (no ctrl combo) but clears modifier", async () => {
    const { ws } = await renderMobile();
    const ctrl = screen.getByTestId("cli-key-ctrl");
    fireEvent.click(ctrl);
    fireEvent.click(screen.getByTestId("cli-key-arrow-up"));
    // Arrow has no Ctrl combo → literal CSI sequence is sent, modifier clears.
    expect(inputFrames(ws)).toContain("\x1b[A");
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
  });

  // ── Input field submit ────────────────────────────────────────────────────
  it("submitting the input field sends the text then exactly one \\r", async () => {
    const { ws } = await renderMobile();
    const input = screen.getByTestId("cli-terminal-mobile-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ls -la" } });
    fireEvent.click(screen.getByTestId("cli-terminal-mobile-send"));
    const frames = inputFrames(ws);
    expect(frames).toEqual(["ls -la", "\r"]);
    // Field is cleared after submit.
    expect(input.value).toBe("");
  });

  it("input is user keystrokes — text is forwarded verbatim (no neutralization)", async () => {
    const { ws } = await renderMobile();
    const input = screen.getByTestId("cli-terminal-mobile-input") as HTMLInputElement;
    // An escape sequence typed by the user is sent verbatim (deliberate input).
    fireEvent.change(input, { target: { value: "echo \x1b[31m" } });
    fireEvent.click(screen.getByTestId("cli-terminal-mobile-send"));
    expect(inputFrames(ws)).toContain("echo \x1b[31m");
  });

  // ── iOS composer pattern: bar keys do not blur the input ──────────────────
  it("bar key pointerdown preventDefault keeps the input focused", async () => {
    await renderMobile();
    const esc = screen.getByTestId("cli-key-esc");
    const pdEvent = new Event("pointerdown", { bubbles: true, cancelable: true });
    esc.dispatchEvent(pdEvent);
    expect(pdEvent.defaultPrevented).toBe(true);
  });

  it("send button pointerdown preventDefault keeps the input focused", async () => {
    await renderMobile();
    const send = screen.getByTestId("cli-terminal-mobile-send");
    const pdEvent = new Event("pointerdown", { bubbles: true, cancelable: true });
    send.dispatchEvent(pdEvent);
    expect(pdEvent.defaultPrevented).toBe(true);
  });

  // ── AE6 mobile leg: same live bytes reach term.write ──────────────────────
  it("mobile attach renders the same live session bytes (data → term.write)", async () => {
    const { ws } = await renderMobile();
    const b64 = Buffer.from("live-bytes", "utf8").toString("base64");
    ws.onmessage?.({ data: JSON.stringify({ type: "data", data: b64 }) });
    await waitFor(() =>
      expect(mockTerm.write).toHaveBeenCalledWith("live-bytes", expect.any(Function)),
    );
  });

  it("xterm onData input is still attached on mobile (bar is primary, not exclusive)", async () => {
    await renderMobile();
    expect(mockTerm.onData).toHaveBeenCalled();
  });

  it("never loads WebGL on mobile even when renderer preference is auto", async () => {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    window.localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_TERMINAL_PREFERENCES, renderer: "auto" }),
    );

    await renderMobile();

    expect(WebglAddon).not.toHaveBeenCalled();
    expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);
  });

  it("keeps the accessory key bar intact while applying terminal preferences", async () => {
    window.localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({
        ...DEFAULT_TERMINAL_PREFERENCES,
        fontFamily: "fira-code",
        cursorStyle: "underline",
      }),
    );

    await renderMobile();

    expect(screen.getByTestId("cli-terminal-key-bar")).toBeTruthy();
    expect(screen.getByTestId("cli-key-ctrl")).toBeTruthy();
    expect(screen.getByTestId("cli-key-esc")).toBeTruthy();
    expect(screen.getByTestId("cli-key-tab")).toBeTruthy();
    expect(screen.getByTestId("cli-key-ctrl-c")).toBeTruthy();
    expect(screen.getByTestId("cli-key-arrow-up")).toBeTruthy();
    expect(screen.getByTestId("cli-key-arrow-down")).toBeTruthy();
    expect(screen.getByTestId("cli-key-arrow-left")).toBeTruthy();
    expect(screen.getByTestId("cli-key-arrow-right")).toBeTruthy();
  });

  it("does not let an older mobile font-metric wait overwrite newer terminal preferences", async () => {
    await renderMobile();
    await waitFor(() => expect(terminalPreferenceMocks.waitForTerminalFontMetrics).toHaveBeenCalled());

    const pendingFontWaits: Array<(value: boolean) => void> = [];
    terminalPreferenceMocks.waitForTerminalFontMetrics.mockReset();
    terminalPreferenceMocks.waitForTerminalFontMetrics.mockImplementation(
      () => new Promise<boolean>((resolve) => pendingFontWaits.push(resolve)),
    );

    const setPreferenceFontSize = (fontSize: number) => {
      window.localStorage.setItem(
        TERMINAL_PREFERENCES_KEY,
        JSON.stringify({ ...DEFAULT_TERMINAL_PREFERENCES, fontSize }),
      );
      window.dispatchEvent(new StorageEvent("storage", { key: TERMINAL_PREFERENCES_KEY }));
    };

    setPreferenceFontSize(10);
    expect(mockTerm.options.fontSize).toBe(10);
    setPreferenceFontSize(14);
    expect(mockTerm.options.fontSize).toBe(14);
    expect(terminalPreferenceMocks.waitForTerminalFontMetrics).toHaveBeenCalledTimes(2);

    await act(async () => {
      pendingFontWaits[0]?.(true);
      await Promise.resolve();
    });
    expect(mockTerm.options.fontSize).toBe(14);

    await act(async () => {
      pendingFontWaits[1]?.(true);
      await Promise.resolve();
    });
    expect(mockTerm.options.fontSize).toBe(14);
    expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);
  });
});

// ── Keyboard-open (fixed-footer) + pinch-zoom guard ──────────────────────────
describe("SessionTerminal (mobile) — keyboard-open behavior", () => {
  let savedVisualViewport: typeof window.visualViewport;
  let savedDocumentElementClientHeight: number;

  function installVisualViewport({
    innerHeight,
    vvHeight,
    scale = 1,
    vvOffsetTop = 0,
    vvWidth = 375,
  }: {
    innerHeight: number;
    vvHeight: number;
    scale?: number;
    vvOffsetTop?: number;
    vvWidth?: number;
  }) {
    (window as unknown as { ontouchstart: unknown }).ontouchstart = null;
    Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 375, writable: true, configurable: true });
    Object.defineProperty(window, "innerHeight", {
      value: innerHeight,
      writable: true,
      configurable: true,
    });
    const listeners: Record<string, Array<() => void>> = { resize: [], scroll: [] };
    const mockVV = {
      width: vvWidth,
      height: vvHeight,
      offsetTop: vvOffsetTop,
      offsetLeft: 0,
      scale,
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

  beforeEach(() => {
    FakeWS.instances = [];
    window.localStorage.clear();
    mockTerm.loadAddon.mockClear();
    mockTerm.open.mockClear();
    mockTerm.onData.mockReset();
    mockTerm.options = {};
    mockFitAddon.fit.mockClear();
    apiMock.mockReset();
    apiMock.mockResolvedValue({ ticket: "tkt-1", expiresAt: "", readOnly: false });
    installMatchMedia(true);
    _resetInitialViewportHeight();
    savedVisualViewport = window.visualViewport;
    savedDocumentElementClientHeight = document.documentElement.clientHeight;
  });

  afterEach(() => {
    Object.defineProperty(window, "visualViewport", {
      value: savedVisualViewport,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: savedDocumentElementClientHeight,
      configurable: true,
    });
    _resetInitialViewportHeight();
    vi.clearAllMocks();
  });

  it("keyboard-open applies the fixed-footer class so the bar is not occluded", async () => {
    installVisualViewport({ innerHeight: 800, vvHeight: 600 });
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

    render(<SessionTerminal sessionId="s1" />);
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));

    await waitFor(() => {
      const bar = screen.getByTestId("cli-terminal-mobile-bar");
      expect(bar.className).toContain("cli-session-terminal__mobile-bar--keyboard-open");
      // Bar lifted above the keyboard by keyboardOverlap (800 - 600 = 200).
      expect(bar.style.bottom).toBe("200px");
    });

    input.remove();
  });

  it("keeps initial iOS keyboard-open 12px metrics when layout height already shrank", async () => {
    installMatchMedia(true);
    const originalScreen = window.screen;
    installVisualViewport({ innerHeight: 390, vvHeight: 390, vvWidth: 390 });
    Object.defineProperty(window, "innerWidth", { value: 390, writable: true, configurable: true });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: 390,
      configurable: true,
    });
    Object.defineProperty(window, "screen", {
      configurable: true,
      value: { width: 390, height: 844 },
    });
    window.localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_TERMINAL_PREFERENCES, fontSize: 12 }),
    );
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

    try {
      const { ws } = await renderMobile();

      await waitFor(() => {
        const root = screen.getByTestId("cli-terminal-mobile-bar").closest(".cli-session-terminal");
        expect(root).toHaveClass("cli-session-terminal--mobile");
        expect(root).toHaveAttribute("data-keyboard-open", "true");
        const bar = screen.getByTestId("cli-terminal-mobile-bar");
        expect(bar.className).toContain("cli-session-terminal__mobile-bar--keyboard-open");
        expect(bar.style.bottom).toBe("454px");
      });
      expect(mockTerm.options.fontSize).toBe(12);
      expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);
      await waitFor(() => expect(mockFitAddon.fit).toHaveBeenCalled());
      expect(ws.sent.some((raw) => JSON.parse(raw).type === "resize")).toBe(true);
    } finally {
      input.remove();
      Object.defineProperty(window, "screen", { configurable: true, value: originalScreen });
    }
  });

  it("keeps Android keyboard-open 10px metrics on visualViewport mobile width", async () => {
    installMatchMedia({ width: false, height: false });
    installVisualViewport({ innerHeight: 700, vvHeight: 320, vvWidth: 390 });
    Object.defineProperty(window, "innerWidth", { value: 900, writable: true, configurable: true });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: 700,
      configurable: true,
    });
    window.localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_TERMINAL_PREFERENCES, fontSize: 10 }),
    );
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

    try {
      const { ws } = await renderMobile();

      await waitFor(() => {
        const root = screen.getByTestId("cli-terminal-mobile-bar").closest(".cli-session-terminal");
        expect(root).toHaveClass("cli-session-terminal--mobile");
        expect(root).toHaveAttribute("data-keyboard-open", "true");
        const bar = screen.getByTestId("cli-terminal-mobile-bar");
        expect(bar.className).toContain("cli-session-terminal__mobile-bar--keyboard-open");
        expect(bar.style.bottom).toBe("380px");
      });
      expect(mockTerm.options.fontSize).toBe(10);
      expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);
      await waitFor(() => expect(mockFitAddon.fit).toHaveBeenCalled());
      expect(ws.sent.some((raw) => JSON.parse(raw).type === "resize")).toBe(true);
    } finally {
      input.remove();
    }
  });

  it("keeps initial folded keyboard-open metrics without waiting for unfold", async () => {
    installVisualViewport({ innerHeight: 300, vvHeight: 300 });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: 667,
      configurable: true,
    });
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

    try {
      await renderMobile();

      await waitFor(() => {
        const bar = screen.getByTestId("cli-terminal-mobile-bar");
        expect(bar.className).toContain("cli-session-terminal__mobile-bar--keyboard-open");
        expect(bar.style.bottom).toBe("367px");
      });
      expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);
    } finally {
      input.remove();
    }
  });

  it("re-baselines folded iOS viewport before lifting the mobile input bar", async () => {
    const { listeners, mockVV } = installVisualViewport({ innerHeight: 844, vvHeight: 844 });
    Object.defineProperty(window, "innerWidth", { value: 700, writable: true, configurable: true });
    Object.defineProperty(mockVV, "width", { value: 700, writable: true, configurable: true });

    render(<SessionTerminal sessionId="s1" />);
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));

    // Fold/narrow the device while the keyboard is still closed; this must
    // replace the prior unfolded baseline before a focused input opens.
    Object.defineProperty(window, "innerWidth", { value: 375, writable: true, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 667, writable: true, configurable: true });
    Object.defineProperty(mockVV, "width", { value: 375, writable: true, configurable: true });
    Object.defineProperty(mockVV, "height", { value: 667, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

    Object.defineProperty(window, "innerHeight", { value: 300, writable: true, configurable: true });
    Object.defineProperty(mockVV, "height", { value: 300, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      const bar = screen.getByTestId("cli-terminal-mobile-bar");
      expect(bar.className).toContain("cli-session-terminal__mobile-bar--keyboard-open");
      expect(bar.style.bottom).toBe("367px");
    });

    input.remove();
  });

  it("pinch-zoom (vv.scale > 1) is NOT treated as keyboard-open", async () => {
    installVisualViewport({ innerHeight: 800, vvHeight: 600, scale: 2 });
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

    render(<SessionTerminal sessionId="s1" />);
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));

    // Give the keyboard hook a beat to settle; it must stay closed.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const bar = screen.getByTestId("cli-terminal-mobile-bar");
    expect(bar.className).not.toContain("cli-session-terminal__mobile-bar--keyboard-open");
    expect(bar.getAttribute("data-keyboard-open")).not.toBe("true");

    input.remove();
  });
});
