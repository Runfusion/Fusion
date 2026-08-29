import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TERMINAL_PREFERENCES,
  LEGACY_TERMINAL_FONT_SIZE_KEY,
  MAX_TERMINAL_CUSTOM_SHORTCUT_LABEL_LENGTH,
  MAX_TERMINAL_CUSTOM_SHORTCUT_VALUE_LENGTH,
  MAX_TERMINAL_CUSTOM_SHORTCUTS,
  TERMINAL_PREFERENCES_KEY,
  XTERM_FONT_FAMILY,
  decodeTerminalShortcutSequence,
  forceTerminalFontRemeasure,
  normalizeTerminalCustomShortcuts,
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
      ...DEFAULT_TERMINAL_PREFERENCES,
      fontFamily: "system-mono",
      fontSize: 22,
      cursorStyle: "underline",
      cursorBlink: false,
      renderer: "canvas",
    });
    expect(readTerminalPreferences()).toEqual(written);
    expect(localStorage.getItem(LEGACY_TERMINAL_FONT_SIZE_KEY)).toBe("22");
  });

  it("normalizes missing, corrupt, and non-array custom shortcuts to an empty list", () => {
    expect(readTerminalPreferences().customShortcuts).toEqual([]);

    localStorage.setItem(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_TERMINAL_PREFERENCES, customShortcuts: "bad" }),
    );
    expect(readTerminalPreferences().customShortcuts).toEqual([]);

    expect(normalizeTerminalCustomShortcuts(null)).toEqual([]);
  });

  it("drops invalid custom shortcuts and caps labels, values, ids, and list length", () => {
    const longLabel = ` ${"L".repeat(MAX_TERMINAL_CUSTOM_SHORTCUT_LABEL_LENGTH + 5)} `;
    const longValue = ` ${"v".repeat(MAX_TERMINAL_CUSTOM_SHORTCUT_VALUE_LENGTH + 5)} `;
    const normalized = normalizeTerminalCustomShortcuts([
      null,
      { id: "keep", label: "  Status  ", value: " git status\\n " },
      { id: "empty-label", label: " ", value: "echo nope" },
      { id: "empty-value", label: "Nope", value: " " },
      { id: "keep", label: "Duplicate", value: "pwd\\n" },
      { label: longLabel, value: longValue },
      ...Array.from({ length: MAX_TERMINAL_CUSTOM_SHORTCUTS + 5 }, (_, index) => ({
        id: `extra-${index}`,
        label: `E${index}`,
        value: `echo ${index}`,
      })),
    ]);

    expect(normalized).toHaveLength(MAX_TERMINAL_CUSTOM_SHORTCUTS);
    expect(normalized[0]).toEqual({ id: "keep", label: "Status", value: "git status\\n" });
    expect(normalized[1]?.id).not.toBe("keep");
    expect(new Set(normalized.map((shortcut) => shortcut.id)).size).toBe(normalized.length);
    expect(normalized[2]?.label).toHaveLength(MAX_TERMINAL_CUSTOM_SHORTCUT_LABEL_LENGTH);
    expect(normalized[2]?.value).toHaveLength(MAX_TERMINAL_CUSTOM_SHORTCUT_VALUE_LENGTH);
  });

  it("round-trips valid custom shortcuts through the existing preferences record", () => {
    const written = writeTerminalPreferences({
      customShortcuts: [
        { id: "cs-status", label: "Status", value: "git status\\n" },
        { id: "cs-clear", label: "Clear", value: "clear\\n" },
      ],
    });

    expect(written.customShortcuts).toEqual([
      { id: "cs-status", label: "Status", value: "git status\\n" },
      { id: "cs-clear", label: "Clear", value: "clear\\n" },
    ]);
    expect(readTerminalPreferences().customShortcuts).toEqual(written.customShortcuts);
    expect(JSON.parse(localStorage.getItem(TERMINAL_PREFERENCES_KEY) ?? "null")).toEqual(written);
  });

  it("decodes terminal shortcut escape sequences and preserves unknown escapes", () => {
    expect(decodeTerminalShortcutSequence("git status\\n")).toBe("git status\n");
    expect(decodeTerminalShortcutSequence("col1\\tcol2\\r")).toBe("col1\tcol2\r");
    expect(decodeTerminalShortcutSequence("esc=\\e alt=\\x1b")).toBe("esc=\x1b alt=\x1b");
    expect(decodeTerminalShortcutSequence("literal=\\\\ unknown=\\q tail=\\")).toBe(
      "literal=\\ unknown=\\q tail=\\",
    );
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
});
