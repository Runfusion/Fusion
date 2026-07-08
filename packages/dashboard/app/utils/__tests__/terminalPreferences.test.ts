import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TERMINAL_PREFERENCES,
  LEGACY_TERMINAL_FONT_SIZE_KEY,
  TERMINAL_PREFERENCES_KEY,
  XTERM_FONT_FAMILY,
  forceTerminalFontRemeasure,
  guardAgainstCollapsedTerminalScreen,
  isTerminalScreenCollapsed,
  readTerminalPreferences,
  waitForTerminalFontMetrics,
  writeTerminalPreferences,
} from "../terminalPreferences";

describe("terminalPreferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns defaults when storage is empty", () => {
    expect(readTerminalPreferences()).toEqual(DEFAULT_TERMINAL_PREFERENCES);
  });

  it("falls back to defaults for corrupt JSON", () => {
    localStorage.setItem(TERMINAL_PREFERENCES_KEY, "not-json");

    expect(readTerminalPreferences()).toEqual(DEFAULT_TERMINAL_PREFERENCES);
  });

  it("clamps font size values", () => {
    localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_TERMINAL_PREFERENCES, fontSize: 99 }),
    );
    expect(readTerminalPreferences().fontSize).toBe(32);

    localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_TERMINAL_PREFERENCES, fontSize: 1 }),
    );
    expect(readTerminalPreferences().fontSize).toBe(8);
  });

  it("rejects unknown enum values to defaults", () => {
    localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({
        fontFamily: "comic-sans",
        fontSize: 16,
        cursorStyle: "boxy",
        cursorBlink: false,
        renderer: "webgl-only",
      }),
    );

    expect(readTerminalPreferences()).toEqual({
      ...DEFAULT_TERMINAL_PREFERENCES,
      fontSize: 16,
      cursorBlink: false,
    });
  });

  it("migrates the legacy font-size key on first read", () => {
    localStorage.setItem(LEGACY_TERMINAL_FONT_SIZE_KEY, "20");

    expect(readTerminalPreferences()).toEqual({
      ...DEFAULT_TERMINAL_PREFERENCES,
      fontSize: 20,
    });
    expect(JSON.parse(localStorage.getItem(TERMINAL_PREFERENCES_KEY) ?? "null")).toEqual({
      ...DEFAULT_TERMINAL_PREFERENCES,
      fontSize: 20,
    });
  });

  it("round-trips normalized writes", () => {
    const written = writeTerminalPreferences({
      fontFamily: "system-mono",
      fontSize: 22,
      cursorStyle: "underline",
      cursorBlink: false,
      renderer: "canvas",
    });

    expect(written).toEqual({
      fontFamily: "system-mono",
      fontSize: 22,
      cursorStyle: "underline",
      cursorBlink: false,
      renderer: "canvas",
    });
    expect(readTerminalPreferences()).toEqual(written);
    expect(localStorage.getItem(LEGACY_TERMINAL_FONT_SIZE_KEY)).toBe("22");
  });

  it("keeps terminal font metrics wait best-effort when iOS rejects the full stack shorthand", async () => {
    let readyAwaited = false;
    const load = vi.fn((font: string) => {
      if (font.includes(",")) {
        return Promise.reject(new DOMException("Invalid font shorthand"));
      }
      return Promise.resolve([]);
    });
    const ready = Promise.resolve().then(() => {
      readyAwaited = true;
    });

    await expect(
      waitForTerminalFontMetrics(12, XTERM_FONT_FAMILY, {
        load,
        ready,
      }),
    ).resolves.toBe(true);

    expect(load).toHaveBeenCalledWith(expect.stringContaining("MesloLGS NF"));
    expect(load).toHaveBeenCalledWith("12px \"MesloLGS NF\"");
    expect(load).not.toHaveBeenCalledWith("12px \"Fusion Terminal Nerd Font Symbols\"");
    expect(readyAwaited).toBe(true);
  });

  /*
  FNXC:Terminal 2026-07-04-09:55:
  FN-7561 root cause: xterm's real OptionsService setter is a no-op when a
  caller reassigns an option to its already-current value, so simply
  reassigning the resolved fontFamily after a web font settles never forces
  xterm's internal CharSizeService/DomRenderer remeasure. Model that exact
  no-op-on-unchanged-value contract and assert `forceTerminalFontRemeasure`
  always produces at least one genuine (distinct-value) transition, even when
  the resolved value already equals the terminal's current option value.
  */
  describe("forceTerminalFontRemeasure", () => {
    function createXtermLikeOptions(initialFontFamily: string) {
      let current = initialFontFamily;
      let changeCount = 0;
      const terminal = {
        options: {
          get fontFamily(): string {
            return current;
          },
          set fontFamily(value: string) {
            if (value !== current) {
              current = value;
              changeCount += 1;
            }
          },
        },
      };
      return { terminal, getChangeCount: () => changeCount };
    }

    it("forces a genuine value transition even when the resolved value already matches the current option", () => {
      const { terminal, getChangeCount } = createXtermLikeOptions(XTERM_FONT_FAMILY);

      // A naive reassignment to the identical value would be a no-op against
      // real xterm and is what let FN-7561 recur; assert the baseline first.
      terminal.options.fontFamily = XTERM_FONT_FAMILY;
      expect(getChangeCount()).toBe(0);

      forceTerminalFontRemeasure(terminal, XTERM_FONT_FAMILY);

      expect(getChangeCount()).toBeGreaterThan(0);
      expect(terminal.options.fontFamily).toBe(XTERM_FONT_FAMILY);
    });

    it("lands on a genuinely different resolved value too", () => {
      const { terminal, getChangeCount } = createXtermLikeOptions(XTERM_FONT_FAMILY);

      forceTerminalFontRemeasure(terminal, "system-mono, monospace");

      expect(getChangeCount()).toBeGreaterThan(0);
      expect(terminal.options.fontFamily).toBe("system-mono, monospace");
    });
  });

  /*
  FN-7692 regression: the mobile terminal rendered blank because xterm's `.xterm-screen` collapsed to
  0x0 (character cell measured 0) even though the prompt data had already arrived. These tests pin the
  guard that detects the collapsed state (container has width, screen does not), forces a genuine
  remeasure + fit until the screen has a real width, waits (does not give up) while the container is not
  yet measurable, and stays bounded when the screen never recovers. Symptom under test = a screen stuck
  at width 0; assertion it is gone = a forced remeasure+fit runs until the screen reports a width.
  */
  describe("guardAgainstCollapsedTerminalScreen", () => {
    let rafQueue: Array<() => void>;
    let resizeObservers: Array<{ cb: () => void; disconnected: boolean }>;

    beforeEach(() => {
      rafQueue = [];
      resizeObservers = [];
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });
      vi.stubGlobal("cancelAnimationFrame", () => {});
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(cb: () => void) {
            resizeObservers.push({ cb, disconnected: false });
          }
          observe(): void {}
          disconnect(): void {
            const entry = resizeObservers[resizeObservers.length - 1];
            if (entry) entry.disconnected = true;
          }
        },
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function flushRaf(max = 200): void {
      let n = 0;
      while (rafQueue.length && n++ < max) {
        const cb = rafQueue.shift();
        cb?.();
      }
    }

    function makeContainer(init: { containerWidth: number; screenWidth: number }) {
      const state = { ...init };
      const screen = {
        getBoundingClientRect: () => ({ width: state.screenWidth }) as DOMRect,
      };
      const container = {
        getBoundingClientRect: () => ({ width: state.containerWidth }) as DOMRect,
        querySelector: (sel: string) => (sel === ".xterm-screen" ? screen : null),
      } as unknown as HTMLElement;
      return { container, state };
    }

    it("classifies collapse only when the container is measurable but the screen is not", () => {
      expect(isTerminalScreenCollapsed(385, 0)).toBe(true);
      expect(isTerminalScreenCollapsed(385, 300)).toBe(false);
      expect(isTerminalScreenCollapsed(0, 0)).toBe(false);
    });

    it("forces a remeasure + fit and stops once the screen reports a width", () => {
      const { container, state } = makeContainer({ containerWidth: 385, screenWidth: 0 });
      const terminal = { options: { fontFamily: XTERM_FONT_FAMILY } };
      let fitCalls = 0;
      // A genuine remeasure+fit recovers the collapsed screen on the first attempt.
      const fit = () => {
        fitCalls += 1;
        state.screenWidth = 300;
      };

      guardAgainstCollapsedTerminalScreen(container, terminal, fit, XTERM_FONT_FAMILY);

      expect(fitCalls).toBe(1);
      expect(state.screenWidth).toBe(300);
      // Recovered synchronously on the initial kick — nothing left scheduled.
      expect(rafQueue.length).toBe(0);
    });

    it("does not act while the container itself is not yet measurable, then recovers on relayout", () => {
      const { container, state } = makeContainer({ containerWidth: 0, screenWidth: 0 });
      const terminal = { options: { fontFamily: XTERM_FONT_FAMILY } };
      let fitCalls = 0;
      const fit = () => {
        fitCalls += 1;
        state.screenWidth = 300;
      };

      guardAgainstCollapsedTerminalScreen(container, terminal, fit, XTERM_FONT_FAMILY);
      // Container has no width yet (mobile modal not settled): must wait, not give up.
      expect(fitCalls).toBe(0);
      expect(resizeObservers[0]?.disconnected).toBe(false);

      // Container becomes measurable; the ResizeObserver re-drives the guard.
      state.containerWidth = 385;
      resizeObservers[0].cb();

      expect(fitCalls).toBe(1);
      expect(state.screenWidth).toBe(300);
    });

    it("stays bounded (never spins) when the screen never recovers", () => {
      const { container } = makeContainer({ containerWidth: 385, screenWidth: 0 });
      const terminal = { options: { fontFamily: XTERM_FONT_FAMILY } };
      let fitCalls = 0;
      const fit = () => {
        fitCalls += 1; // never sets a width — the collapse persists
      };

      guardAgainstCollapsedTerminalScreen(container, terminal, fit, XTERM_FONT_FAMILY, {
        maxAttempts: 3,
      });
      flushRaf();

      expect(fitCalls).toBe(3);
      expect(rafQueue.length).toBe(0);
    });

    it("is a no-op when the screen already has a width at mount", () => {
      const { container } = makeContainer({ containerWidth: 385, screenWidth: 300 });
      const terminal = { options: { fontFamily: XTERM_FONT_FAMILY } };
      let fitCalls = 0;

      guardAgainstCollapsedTerminalScreen(container, terminal, () => (fitCalls += 1), XTERM_FONT_FAMILY);

      expect(fitCalls).toBe(0);
      expect(rafQueue.length).toBe(0);
    });
  });
});
