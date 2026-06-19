import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Mock xterm + addon dynamic imports (jsdom has no canvas/WebGL) ──────────
const mockFitAddon = { fit: vi.fn() };
const mockTerm = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(),
  attachCustomKeyEventHandler: vi.fn(),
  write: vi.fn((_data: string, cb?: () => void) => cb?.()),
  refresh: vi.fn(),
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
  mockTerm.attachCustomKeyEventHandler.mockClear();
  mockTerm.write.mockClear();
  mockTerm.refresh.mockClear();
  mockTerm.dispose.mockClear();
  mockTerm.options = {};
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

  it("read-only: never registers term.onData (input suppressed)", async () => {
    render(<SessionTerminal sessionId="s1" readOnly />);
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    expect(mockTerm.onData).not.toHaveBeenCalled();
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
    expect(mockTerm.attachCustomKeyEventHandler).not.toHaveBeenCalled();

    const inputHandler = mockTerm.onData.mock.calls[0]?.[0] as
      | ((data: string) => void)
      | undefined;
    expect(inputHandler).toBeDefined();
    inputHandler?.("paste once\n");

    expect(FakeWS.instances[0].sent).toEqual([
      JSON.stringify({ type: "input", data: "paste once\n" }),
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
      expect(mockTerm.options.fontSize).toBe(DEFAULT_TERMINAL_PREFERENCES.fontSize);
      expect(mockFitAddon.fit.mock.calls.length).toBeGreaterThan(fitCallBaseline);
      expect(mockTerm.refresh).toHaveBeenCalledWith(0, mockTerm.rows - 1);
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
    render(<SessionTerminal sessionId="s1" />);
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    mockFitAddon.fit.mockClear();

    window.localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({
        fontFamily: "jetbrains-mono",
        fontSize: 20,
        cursorStyle: "bar",
        cursorBlink: false,
        renderer: "canvas",
      }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: TERMINAL_PREFERENCES_KEY }));

    await waitFor(() => {
      expect(mockTerm.options).toMatchObject({
        fontFamily: resolveTerminalFontFamily("jetbrains-mono"),
        fontSize: 20,
        cursorStyle: "bar",
        cursorBlink: false,
      });
    });
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
