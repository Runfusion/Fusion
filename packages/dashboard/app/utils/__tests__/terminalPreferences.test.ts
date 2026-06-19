import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TERMINAL_PREFERENCES,
  LEGACY_TERMINAL_FONT_SIZE_KEY,
  TERMINAL_PREFERENCES_KEY,
  XTERM_FONT_FAMILY,
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
});
