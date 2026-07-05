import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Mock xterm + addon dynamic imports (jsdom has no canvas/WebGL) ──────────
/*
FNXC:Terminal 2026-07-04-11:50:
FN-7567 recurrence #4: forcing a genuine fontFamily/fontSize transition
(FN-7561's `forceTerminalFontRemeasure`) is necessary but not sufficient. Real
xterm's `DomRenderer._setDefaultSpacing()` (the letter-spacing compensation
baked onto `.xterm-rows`) is recomputed on `CharSizeService.onCharSizeChange`
(any genuine option change) and on `handleDevicePixelRatioChange`, but NOT on
`handleResize()` (the path `fitAddon.fit()` -> `terminal.resize(cols, rows)`
takes). `mockFitAddon.fit`/`mockTerm.cols` model this ordering-sensitive
geometry (measured char width, cell width derived from cols, and the baked
letter-spacing) directly, mirroring xterm's real internals, so the regression
asserts actual rendered geometry instead of a CSS-property or call-count check.
*/
const MOCK_CONTAINER_WIDTH_PX = 728;
const MOCK_FALLBACK_CHAR_WIDTH_PX = 9;
const MOCK_SETTLED_CHAR_WIDTH_PX = 7;
let mockFontsSettledForCharSize = false;
let mockMeasuredCharWidthPx = MOCK_FALLBACK_CHAR_WIDTH_PX;
let mockBakedLetterSpacingPx = 0;

function resetMockTerminalGeometry(): void {
  mockFontsSettledForCharSize = false;
  mockMeasuredCharWidthPx = MOCK_FALLBACK_CHAR_WIDTH_PX;
  mockBakedLetterSpacingPx = 0;
  mockTerm.cols = 80;
}

/** Mirrors the real web font finishing its network load/paint settle. */
function settleMockTerminalFontForCharSize(): void {
  mockFontsSettledForCharSize = true;
}

/** The rendered cell/advance-width geometry invariant under test: 0 == tight contiguous monospace. */
function getMockBakedLetterSpacingPx(): number {
  return mockBakedLetterSpacingPx;
}

// Mirrors xterm's CharSizeService.measure() -> onCharSizeChange ->
// DomRenderer.handleCharSizeChanged(): runs on every GENUINE fontFamily/fontSize
// option transition, using the CURRENT (possibly stale, pre-fit) column count.
function mockHandleCharSizeChanged(): void {
  mockMeasuredCharWidthPx = mockFontsSettledForCharSize
    ? MOCK_SETTLED_CHAR_WIDTH_PX
    : MOCK_FALLBACK_CHAR_WIDTH_PX;
  const cols = (mockTerm.cols as number) || 1;
  const cellWidthPx = MOCK_CONTAINER_WIDTH_PX / cols;
  mockBakedLetterSpacingPx = cellWidthPx - mockMeasuredCharWidthPx;
}

// Mirrors FitAddon.fit() -> terminal.resize(cols, rows) ->
// DomRenderer.handleResize(): recomputes cols from the CURRENT measured char
// width but deliberately does NOT touch letter-spacing (real xterm's
// handleResize() never calls _setDefaultSpacing()).
const mockFitAddon = {
  fit: vi.fn(() => {
    mockTerm.cols = Math.max(1, Math.floor(MOCK_CONTAINER_WIDTH_PX / mockMeasuredCharWidthPx));
  }),
};
let sessionKeyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;

/*
FNXC:Terminal 2026-07-04-09:45:
Real xterm.js's OptionsService setter is a strict no-op (no onOptionChange
fires, so CharSizeService/DomRenderer never remeasure) whenever a caller
reassigns an option to a value that already equals the option's current value.
The previous plain `{ ...options }` spread on construction could not model this
no-op-on-unchanged-value behavior, letting FN-7561's recurrence (reassigning
the SAME resolved font after an async web-font settle never forces a genuine
remeasure) go uncaught. Track a `fontRemeasureCount` that only increments on a
genuine (distinct-value) fontFamily/fontSize transition.
*/
let fontRemeasureCount = 0;
function resetFontRemeasureCount(): void {
  fontRemeasureCount = 0;
}
function getFontRemeasureCount(): number {
  return fontRemeasureCount;
}
function wrapMockTerminalOptions(initial: Record<string, unknown>): Record<string, unknown> {
  const store: Record<string, unknown> = { ...initial };
  const options: Record<string, unknown> = {};
  for (const key of Object.keys(store)) {
    Object.defineProperty(options, key, {
      enumerable: true,
      configurable: true,
      get(): unknown {
        return store[key];
      },
      set(value: unknown): void {
        if (store[key] !== value) {
          store[key] = value;
          if (key === "fontFamily" || key === "fontSize") {
            fontRemeasureCount += 1;
            mockHandleCharSizeChanged();
          }
        }
      },
    });
  }
  return options;
}

const mockTerm = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(),
  attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => {
    sessionKeyEventHandler = handler;
  }),
  hasSelection: vi.fn(() => false),
  getSelection: vi.fn(() => ""),
  write: vi.fn((_data: string, cb?: () => void) => cb?.()),
  refresh: vi.fn(),
  dispose: vi.fn(),
  unicode: { activeVersion: "6" },
  options: {} as Record<string, unknown>,
  cols: 80,
  rows: 24,
};
vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function Terminal(options) {
    mockTerm.options = wrapMockTerminalOptions(options as Record<string, unknown>);
    return mockTerm;
  }),
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn(function FitAddon() { return mockFitAddon; }) }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: vi.fn(function Unicode11Addon() { return {}; }) }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function WebglAddon() { return { onContextLoss: vi.fn(), dispose: vi.fn() }; }),
}));

const apiMock = vi.fn();
vi.mock("../../api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));
vi.mock("../../auth", () => ({ appendTokenQuery: (u: string) => u }));

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

import { SessionTerminal } from "../SessionTerminal";
import {
  DEFAULT_TERMINAL_PREFERENCES,
  TERMINAL_PREFERENCES_KEY,
  TERMINAL_SYMBOLS_FONT_FAMILY,
  resolveTerminalFontFamily,
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

beforeEach(() => {
  FakeWS.instances = [];
  originalWebSocket = (globalThis as typeof globalThis & { WebSocket?: typeof WebSocket }).WebSocket;
  (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
  window.localStorage.clear();
  mockTerm.loadAddon.mockClear();
  mockTerm.open.mockClear();
  mockTerm.onData.mockReset();
  sessionKeyEventHandler = null;
  mockTerm.attachCustomKeyEventHandler.mockClear();
  mockTerm.hasSelection.mockReturnValue(false);
  mockTerm.getSelection.mockReturnValue("");
  mockTerm.write.mockClear();
  Object.defineProperty(navigator, "platform", {
    value: "Win32",
    configurable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
  });
  mockTerm.refresh.mockClear();
  mockTerm.dispose.mockClear();
  mockTerm.options = {};
  resetFontRemeasureCount();
  resetMockTerminalGeometry();
  Object.defineProperty(document, "fonts", {
    value: undefined,
    configurable: true,
  });
  mockFitAddon.fit.mockClear();
  apiMock.mockReset();
  apiMock.mockResolvedValue({ ticket: "tkt-1", expiresAt: "", readOnly: false });
});

afterEach(() => {
  (globalThis as typeof globalThis & { WebSocket?: typeof WebSocket }).WebSocket = originalWebSocket;
  vi.clearAllMocks();
});

describe("SessionTerminal", () => {
  it("mints an attach ticket and opens the WS attach channel", async () => {
    render(<SessionTerminal sessionId="s1" />);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/cli-sessions/s1/attach-ticket",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    expect(FakeWS.instances[0].url).toContain("sessionId=s1");
    expect(FakeWS.instances[0].url).toContain("ticket=tkt-1");
  });

  it("decodes base64 scrollback/data into term.write and ACKs", async () => {
    render(<SessionTerminal sessionId="s1" />);
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const ws = FakeWS.instances[0];
    const b64 = Buffer.from("hello", "utf8").toString("base64");
    ws.onmessage?.({ data: JSON.stringify({ type: "scrollback", data: b64 }) });
    await waitFor(() => expect(mockTerm.write).toHaveBeenCalledWith("hello", expect.any(Function)));
  });

  it.each([
    ["read-only", { readOnly: true }],
    ["idle", { mode: "idle" as const }],
    ["ended", { mode: "ended" as const }],
  ])("%s: never registers input handlers", async (_label, props) => {
    render(<SessionTerminal sessionId="s1" {...props} />);
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    expect(mockTerm.onData).not.toHaveBeenCalled();
    expect(mockTerm.attachCustomKeyEventHandler).not.toHaveBeenCalled();
  });

  it("honors server read-only attach tickets when props are live+writable", async () => {
    const { Terminal } = await import("@xterm/xterm");
    apiMock.mockResolvedValue({ ticket: "tkt-ro", expiresAt: "", readOnly: true });

    render(<SessionTerminal sessionId="s1" />);

    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    expect(FakeWS.instances[0].url).toContain("ticket=tkt-ro");
    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        cursorBlink: false,
        disableStdin: true,
      }),
    );
    expect(mockTerm.onData).not.toHaveBeenCalled();
    expect(mockTerm.attachCustomKeyEventHandler).not.toHaveBeenCalled();
    expect(await screen.findByText("Read-only")).toBeTruthy();
  });

  it("relies on native xterm paste while applying the default terminal font preference", async () => {
    const { Terminal } = await import("@xterm/xterm");

    render(<SessionTerminal sessionId="s1" />);

    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: resolveTerminalFontFamily("nerd-font"),
        fontSize: DEFAULT_TERMINAL_PREFERENCES.fontSize,
        cursorStyle: DEFAULT_TERMINAL_PREFERENCES.cursorStyle,
        cursorBlink: DEFAULT_TERMINAL_PREFERENCES.cursorBlink,
      }),
    );
    expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);

    const inputHandler = mockTerm.onData.mock.calls[0]?.[0] as
      | ((data: string) => void)
      | undefined;
    expect(inputHandler).toBeDefined();
    inputHandler?.("paste once\n");

    expect(FakeWS.instances[0].sent).toEqual([
      JSON.stringify({ type: "input", data: "paste once\n" }),
    ]);
  });

  it("drops physical input frames when the attach WebSocket is not open", async () => {
    render(<SessionTerminal sessionId="s1" />);
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    expect(mockTerm.onData).toHaveBeenCalledTimes(1);

    const inputHandler = mockTerm.onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined;
    FakeWS.instances[0].readyState = 3;
    inputHandler?.("dropped");

    expect(FakeWS.instances[0].sent).toEqual([]);
  });

  it.each([
    ["mac", "MacIntel", { metaKey: true }],
    ["non-mac", "Win32", { ctrlKey: true }],
  ] as const)("preserves physical copy/paste terminal semantics on %s", async (_name, platform, modifier) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockResolvedValue("pasted once");
    Object.defineProperty(navigator, "platform", {
      value: platform,
      configurable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, readText },
      configurable: true,
    });

    render(<SessionTerminal sessionId="s1" />);
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    await waitFor(() => expect(sessionKeyEventHandler).not.toBeNull());

    mockTerm.hasSelection.mockReturnValue(true);
    mockTerm.getSelection.mockReturnValue("selected cli output");
    expect(sessionKeyEventHandler?.(new KeyboardEvent("keydown", { key: "c", ...modifier }))).toBe(false);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("selected cli output"));

    mockTerm.hasSelection.mockReturnValue(false);
    expect(sessionKeyEventHandler?.(new KeyboardEvent("keydown", { key: "c", ...modifier }))).toBe(true);

    const beforePasteFrames = FakeWS.instances[0].sent.length;
    expect(sessionKeyEventHandler?.(new KeyboardEvent("keydown", { key: "v", ...modifier }))).toBe(false);
    await waitFor(() => expect(readText).toHaveBeenCalledTimes(1));
    expect(FakeWS.instances[0].sent.slice(beforePasteFrames)).toEqual([
      JSON.stringify({ type: "input", data: "pasted once" }),
    ]);
  });

  it.each([
    ["missing clipboard", undefined],
    ["rejected clipboard", { readText: vi.fn().mockRejectedValue(new DOMException("denied")) }],
    ["empty clipboard", { readText: vi.fn().mockResolvedValue("") }],
  ] as const)("fails safely for %s physical paste while preserving xterm input", async (_label, clipboard) => {
    Object.defineProperty(navigator, "platform", {
      value: "Win32",
      configurable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      value: clipboard,
      configurable: true,
    });

    render(<SessionTerminal sessionId="s1" />);
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    await waitFor(() => expect(sessionKeyEventHandler).not.toBeNull());

    const beforePasteFrames = FakeWS.instances[0].sent.length;
    expect(sessionKeyEventHandler?.(new KeyboardEvent("keydown", { key: "v", ctrlKey: true }))).toBe(false);
    if (clipboard?.readText) {
      await waitFor(() => expect(clipboard.readText).toHaveBeenCalledTimes(1));
    }
    await act(async () => {
      await Promise.resolve();
    });
    expect(FakeWS.instances[0].sent.slice(beforePasteFrames)).toEqual([]);

    const inputHandler = mockTerm.onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined;
    inputHandler?.("typed input");
    expect(FakeWS.instances[0].sent.slice(beforePasteFrames)).toEqual([
      JSON.stringify({ type: "input", data: "typed input" }),
    ]);
  });

  it("refits after font settlement even when iOS rejects the font-load shorthand", async () => {
    const load = vi.fn(() => Promise.reject(new DOMException("Invalid font shorthand")));
    Object.defineProperty(document, "fonts", {
      value: {
        load,
        ready: Promise.resolve(),
      },
      configurable: true,
    });
    const fitCallBaseline = mockFitAddon.fit.mock.calls.length;

    render(<SessionTerminal sessionId="s1" />);

    await waitFor(() => {
      expect(FakeWS.instances.length).toBe(1);
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
      expect(mockTerm.options.fontFamily).toBe(resolveTerminalFontFamily("nerd-font"));
      expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);
      expect(mockTerm.options.fontSize).toBe(DEFAULT_TERMINAL_PREFERENCES.fontSize);
      expect(mockFitAddon.fit.mock.calls.length).toBeGreaterThan(fitCallBaseline);
      expect(mockTerm.refresh).toHaveBeenCalledWith(0, mockTerm.rows - 1);
    });
  });

  /*
  FNXC:Terminal 2026-07-04-09:50:
  FN-7561 recurrence #3 root cause: reassigning `terminal.options.fontFamily`/`fontSize`
  to the SAME already-resolved value (the common case, since preferences are
  unchanged) is a no-op against real xterm's OptionsService — no `onOptionChange`
  fires, so CharSizeService/DomRenderer never remeasure the web font that only
  just finished loading after xterm's initial pre-load measurement. This proves
  SessionTerminal forces a genuine value transition on settle too, not just
  TerminalModal.
  */
  it("forces a genuine xterm character-metric remeasure after the mobile web font settles later than xterm's initial measurement", async () => {
    let resolveLoad: (() => void) | undefined;
    let resolveReady: (() => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    Object.defineProperty(document, "fonts", {
      value: {
        load,
        ready: new Promise<void>((resolve) => {
          resolveReady = resolve;
        }),
      },
      configurable: true,
    });

    render(<SessionTerminal sessionId="s1" />);

    await waitFor(() => {
      expect(FakeWS.instances.length).toBe(1);
      expect(load).toHaveBeenCalled();
    });
    expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);

    // Isolate exactly what happens once the deferred font-load settles; the
    // resolved fontFamily/fontSize never actually changed (the user never
    // touched terminal preferences), so this must be a forced remeasure, not
    // an incidental preference-driven one.
    resetFontRemeasureCount();
    resetMockTerminalGeometry();

    await act(async () => {
      resolveLoad?.();
      resolveReady?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getFontRemeasureCount()).toBeGreaterThan(0);
    });

    expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);
    expect(mockTerm.options.fontFamily).toBe(resolveTerminalFontFamily("nerd-font"));
  });

  /*
  FNXC:Terminal 2026-07-04-11:55:
  FN-7567 recurrence #4: forcing a genuine remeasure (the assertion above) is
  necessary but not sufficient. Real xterm's `DomRenderer._setDefaultSpacing()`
  letter-spacing bake only recomputes from a genuine option-change remeasure or
  a devicePixelRatio change, never from the `fitAddon.fit()`/resize that
  follows it, so a settle that bakes spacing BEFORE fit() leaves it stale
  against the post-fit column count until an unrelated later event happens to
  force another remeasure. This asserts the measured rendered geometry
  invariant (baked letter-spacing == 0) using a xterm-internals-accurate model,
  not a re-assertion of the FN-7561 call-count/CSS-property checks; it fails on
  pre-fix code and passes once the settle re-bakes spacing AFTER fit().
  */
  it("renders contiguous monospace cells (zero baked letter-spacing) once the mobile web font settles after xterm's initial fit", async () => {
    let resolveLoad: (() => void) | undefined;
    let resolveReady: (() => void) | undefined;
    Object.defineProperty(document, "fonts", {
      value: {
        load: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveLoad = resolve;
            }),
        ),
        ready: new Promise<void>((resolve) => {
          resolveReady = resolve;
        }),
      },
      configurable: true,
    });

    render(<SessionTerminal sessionId="s1" />);

    await waitFor(() => {
      expect(FakeWS.instances.length).toBe(1);
    });
    resetFontRemeasureCount();

    // Simulate the real recurrence: the custom web font finishes downloading
    // AFTER xterm's initial fallback-font measurement/fit already ran and
    // baked a letter-spacing value that was internally consistent for the
    // FALLBACK font at that (stale) column count.
    settleMockTerminalFontForCharSize();

    await act(async () => {
      resolveLoad?.();
      resolveReady?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getFontRemeasureCount()).toBeGreaterThan(0);
    });

    // The measured geometry invariant: once font metrics settle and xterm
    // refits to the correct column count for the SETTLED font, the baked
    // letter-spacing compensation must be recomputed against that FINAL
    // column count, not the stale pre-fit one.
    await waitFor(() => {
      expect(getMockBakedLetterSpacingPx()).toBeCloseTo(0, 5);
    });
  });

  it("applies validated terminal preferences at xterm init", async () => {
    const { Terminal } = await import("@xterm/xterm");
    window.localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({
        fontFamily: "system-mono",
        fontSize: 18,
        cursorStyle: "underline",
        cursorBlink: true,
        renderer: "auto",
      }),
    );

    render(<SessionTerminal sessionId="s1" />);

    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: resolveTerminalFontFamily("system-mono"),
        fontSize: 18,
        cursorStyle: "underline",
        cursorBlink: true,
      }),
    );
    expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);
  });

  it("falls back to safe default preferences for corrupt storage", async () => {
    const { Terminal } = await import("@xterm/xterm");
    window.localStorage.setItem(TERMINAL_PREFERENCES_KEY, "{not-json");

    render(<SessionTerminal sessionId="s1" />);

    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: resolveTerminalFontFamily("nerd-font"),
        fontSize: DEFAULT_TERMINAL_PREFERENCES.fontSize,
        cursorStyle: DEFAULT_TERMINAL_PREFERENCES.cursorStyle,
        cursorBlink: true,
      }),
    );
    expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);
  });

  it.each([
    { label: "read-only", props: { readOnly: true } },
    { label: "idle", props: { mode: "idle" as const } },
    { label: "ended", props: { mode: "ended" as const } },
  ])("keeps cursor blink disabled for $label sessions", async ({ props }) => {
    const { Terminal } = await import("@xterm/xterm");
    window.localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_TERMINAL_PREFERENCES, cursorBlink: true }),
    );

    render(<SessionTerminal sessionId="s1" {...props} />);

    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        cursorBlink: false,
      }),
    );
  });

  it("skips WebGL on desktop when renderer preference is canvas", async () => {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    window.localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_TERMINAL_PREFERENCES, renderer: "canvas" }),
    );

    render(<SessionTerminal sessionId="s1" />);

    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    await waitFor(() => expect(mockTerm.open).toHaveBeenCalled());
    expect(WebglAddon).not.toHaveBeenCalled();
  });

  it("loads WebGL on desktop when renderer preference is auto", async () => {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    window.localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_TERMINAL_PREFERENCES, renderer: "auto" }),
    );

    render(<SessionTerminal sessionId="s1" />);

    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    await waitFor(() => expect(WebglAddon).toHaveBeenCalled());
    expect(mockTerm.loadAddon).toHaveBeenCalledWith(
      expect.objectContaining({ onContextLoss: expect.any(Function) }),
    );
  });

  it("live-applies font and cursor preference changes from storage events", async () => {
    const fontLoad = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, "fonts", {
      value: {
        load: fontLoad,
        ready: Promise.resolve(),
      },
      configurable: true,
    });
    render(<SessionTerminal sessionId="s1" />);
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    mockFitAddon.fit.mockClear();
    mockTerm.refresh.mockClear();
    fontLoad.mockClear();

    window.localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({
        fontFamily: "jetbrains-mono",
        fontSize: 10,
        cursorStyle: "bar",
        cursorBlink: false,
        renderer: "canvas",
      }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: TERMINAL_PREFERENCES_KEY }));

    await waitFor(() => {
      expect(mockTerm.options).toMatchObject({
        fontFamily: resolveTerminalFontFamily("jetbrains-mono"),
        fontSize: 10,
        cursorStyle: "bar",
        cursorBlink: false,
      });
    });
    await waitFor(() => expect(fontLoad).toHaveBeenCalledWith(expect.stringContaining("10px")));
    await waitFor(() => expect(mockTerm.refresh).toHaveBeenCalledWith(0, mockTerm.rows - 1));
    expectMeasurementSafeFontStack(mockTerm.options.fontFamily as string);
    expect(mockFitAddon.fit).toHaveBeenCalled();
  });

  it("ignores unrelated storage events when live-applying preferences", async () => {
    render(<SessionTerminal sessionId="s1" />);
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    mockFitAddon.fit.mockClear();

    window.localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_TERMINAL_PREFERENCES, fontSize: 22 }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));

    expect(mockTerm.options.fontSize).not.toBe(22);
    expect(mockFitAddon.fit).not.toHaveBeenCalled();
  });

  it("renders the Read-only badge when readOnly", async () => {
    render(<SessionTerminal sessionId="s1" readOnly />);
    expect(await screen.findByText("Read-only")).toBeTruthy();
  });

  it("renders the session-ended replay state", () => {
    render(<SessionTerminal sessionId="s1" mode="ended" />);
    expect(screen.getByText("Session ended")).toBeTruthy();
  });

  it("renders the session-idle replay state", () => {
    render(<SessionTerminal sessionId="s1" mode="idle" />);
    expect(screen.getByText("Session idle")).toBeTruthy();
  });

  it("posture chip: baseline shows adapter name without elevated styling", () => {
    render(
      <SessionTerminal
        sessionId="s1"
        posture={{ adapterName: "Claude Code", mode: "default", elevated: false }}
      />,
    );
    const chip = screen.getByRole("button", { name: /Claude Code/ });
    expect(chip.getAttribute("data-elevated")).toBe("false");
    expect(chip.className).not.toContain("cli-posture-chip--elevated");
  });

  it("posture chip: elevated shows warning styling, the flag, and a tooltip", () => {
    render(
      <SessionTerminal
        sessionId="s1"
        posture={{
          adapterName: "Codex",
          elevated: true,
          elevatedFlags: ["--dangerously-skip-permissions"],
          resolved: ["autonomy: full-auto"],
        }}
      />,
    );
    const chip = screen.getByRole("button", { name: /Codex/ });
    expect(chip.getAttribute("data-elevated")).toBe("true");
    expect(chip.className).toContain("cli-posture-chip--elevated");
    expect(screen.getByText("--dangerously-skip-permissions")).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(screen.getByText("autonomy: full-auto")).toBeTruthy();
  });

  it("confirm-advance strip: Advance posts advance and hides the strip", async () => {
    const onConfirmAdvance = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionTerminal
        sessionId="s1"
        mode="live"
        showConfirmAdvance
        onConfirmAdvance={onConfirmAdvance}
      />,
    );
    const advance = screen.getByText("Advance");
    fireEvent.click(advance);
    await waitFor(() => expect(onConfirmAdvance).toHaveBeenCalledWith("advance"));
    await waitFor(() => expect(screen.queryByText("Advance")).toBeNull());
  });

  it("confirm-advance strip: Not yet re-arms (calls callback, hides strip)", async () => {
    const onConfirmAdvance = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionTerminal
        sessionId="s1"
        mode="live"
        showConfirmAdvance
        onConfirmAdvance={onConfirmAdvance}
      />,
    );
    fireEvent.click(screen.getByText("Not yet"));
    await waitFor(() => expect(onConfirmAdvance).toHaveBeenCalledWith("not-yet"));
    await waitFor(() => expect(screen.queryByText("Not yet")).toBeNull());
  });
});
