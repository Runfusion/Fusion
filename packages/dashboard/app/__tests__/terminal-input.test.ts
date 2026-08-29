import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import {
  TERMINAL_FONT_FAMILY_PRESETS,
  TERMINAL_SYMBOLS_FONT_FAMILY,
  XTERM_FONT_FAMILY,
  resolveTerminalFontFamily,
} from "../utils/terminalPreferences";

const css = loadAllAppCss();
const terminalModalCss = readFileSync(
  resolve(__dirname, "../components/TerminalModal.css"),
  "utf8",
);
const sessionTerminalCss = readFileSync(
  resolve(__dirname, "../components/SessionTerminal.css"),
  "utf8",
);

function findHelperTextareaRule(): string {
  const match = css.match(
    /\.terminal-xterm\s+\.xterm\s+\.xterm-helper-textarea\s*\{([^}]*)\}/,
  );
  return match?.[1] ?? "";
}

function findTerminalTextSizingRule(): string {
  const match = css.match(/\.terminal-xterm\s*,\s*\.terminal-xterm \*\s*\{([^}]*)\}/);
  return match?.[1] ?? "";
}

function findSessionTerminalTextSizingRule(): string {
  const match = css.match(
    /\.cli-session-terminal__viewport\s*,\s*\.cli-session-terminal__viewport \*\s*\{([^}]*)\}/,
  );
  return match?.[1] ?? "";
}

function findTerminalGlyphFallbackRule(): string {
  const match = css.match(/\.terminal-xterm\s+\.xterm-rows\s+span\s*\{([^}]*)\}/);
  return match?.[1] ?? "";
}

function findSessionTerminalGlyphFallbackRule(): string {
  const match = css.match(
    /\.cli-session-terminal__viewport\s+\.xterm-rows\s+span\s*\{([^}]*)\}/,
  );
  return match?.[1] ?? "";
}

function expectTextSizeAdjustDisabledForExactXtermMetrics(ruleBody: string): void {
  expect(ruleBody).not.toBe("");
  expect(ruleBody).toMatch(/-webkit-text-size-adjust\s*:\s*none\s*;/);
  expect(ruleBody).toMatch(/text-size-adjust\s*:\s*none\s*;/);
}

function findTerminalSymbolsFontFaceRule(cssSource = css): string {
  const fontFaceRules = cssSource.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  return (
    fontFaceRules.find((rule) =>
      /font-family\s*:\s*["']Fusion Terminal Nerd Font Symbols["']/.test(rule),
    ) ?? ""
  );
}

function parseUnicodeRangeValues(ruleBody: string): string[] {
  const match = ruleBody.match(/unicode-range\s*:\s*([^;}]*)/i);
  return match?.[1]
    .split(",")
    .map((range) => range.trim().toUpperCase())
    .filter(Boolean) ?? [];
}

function unicodeRangeIncludesAsciiPrintable(range: string): boolean {
  const normalized = range.toUpperCase();
  const rangeMatch = normalized.match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/);
  if (!rangeMatch) {
    return false;
  }

  const [, startRaw, endRaw] = rangeMatch;
  if (startRaw.includes("?")) {
    const start = Number.parseInt(startRaw.replace(/\?/g, "0"), 16);
    const end = Number.parseInt(startRaw.replace(/\?/g, "F"), 16);
    return start <= 0x007e && end >= 0x0020;
  }

  const start = Number.parseInt(startRaw, 16);
  const end = endRaw ? Number.parseInt(endRaw, 16) : start;
  return start <= 0x007e && end >= 0x0020;
}

describe("terminal helper textarea CSS contract", () => {
  it("defines the xterm helper textarea rule", () => {
    const ruleBody = findHelperTextareaRule();
    expect(ruleBody).not.toBe("");
  });

  it("keeps mobile-friendly helper textarea dimensions", () => {
    const ruleBody = findHelperTextareaRule();
    expect(ruleBody).toMatch(/width:\s*1px\b/);
    expect(ruleBody).toMatch(/height:\s*1px\b/);
  });

  it("anchors the helper textarea inside the terminal bounds", () => {
    const ruleBody = findHelperTextareaRule();
    expect(ruleBody).toMatch(/top:\s*0\b/);
    expect(ruleBody).toMatch(/left:\s*0\b/);
  });

  it("keeps helper textarea pointer-focusable for mobile keyboard activation", () => {
    const ruleBody = findHelperTextareaRule();
    expect(ruleBody).toMatch(/pointer-events\s*:\s*auto\b/);
  });

  it("keeps the helper textarea effectively invisible", () => {
    const ruleBody = findHelperTextareaRule();
    expect(ruleBody).toMatch(/opacity:\s*0\.01\b/);
  });

  it("disables iOS text-size adjustment across the xterm measurement subtree", () => {
    expectTextSizeAdjustDisabledForExactXtermMetrics(findTerminalTextSizingRule());
  });

  it("disables iOS text-size adjustment on the SessionTerminal xterm viewport", () => {
    expectTextSizeAdjustDisabledForExactXtermMetrics(findSessionTerminalTextSizingRule());
  });

  it("keeps a DOM glyph fallback mechanism outside xterm measurement options", () => {
    expect(findTerminalGlyphFallbackRule()).toMatch(/--terminal-glyph-font-family/);
    expect(findSessionTerminalGlyphFallbackRule()).toMatch(/--terminal-glyph-font-family/);
    expect(findTerminalGlyphFallbackRule()).not.toMatch(/Fusion Terminal Nerd Font Symbols/);
    expect(findSessionTerminalGlyphFallbackRule()).not.toMatch(/Fusion Terminal Nerd Font Symbols/);
  });
});

describe("FN-6424 terminal symbols font CSS contract", () => {
  function expectScopedSymbolsFontFace(cssSource: string, surface: string): void {
    const ruleBody = findTerminalSymbolsFontFaceRule(cssSource);
    expect(ruleBody, `${surface} symbols @font-face`).not.toBe("");

    const unicodeRanges = parseUnicodeRangeValues(ruleBody);
    expect(unicodeRanges, `${surface} required Nerd Font ranges`).toEqual(
      expect.arrayContaining(["U+E0A0-E0D7", "U+E700-E8EF", "U+F0001-F1AF0"]),
    );
    expect(
      unicodeRanges.some(unicodeRangeIncludesAsciiPrintable),
      `${surface} symbols @font-face excludes printable ASCII`,
    ).toBe(false);
  }

  it("scopes the symbols-only Nerd Font away from ASCII cell measurement", () => {
    expectScopedSymbolsFontFace(css, "combined app CSS");
  });

  it("keeps the scoped symbols face owned by each terminal surface CSS chunk", () => {
    expectScopedSymbolsFontFace(terminalModalCss, "TerminalModal.css");
    expectScopedSymbolsFontFace(sessionTerminalCss, "SessionTerminal.css");
  });
});

describe("FN-6659 terminal font stack measurement contract", () => {
  const symbolsFamily = TERMINAL_SYMBOLS_FONT_FAMILY;

  function splitFontFamilies(stack: string): string[] {
    return stack
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((family) => family.trim())
      .filter(Boolean);
  }

  it("keeps the default xterm measurement family free of the symbols face", () => {
    const families = splitFontFamilies(XTERM_FONT_FAMILY);

    expect(families).not.toContain(symbolsFamily);
    expect(families.length).toBeGreaterThan(0);
  });

  it("keeps every terminal preset free of the symbols face xterm measures", () => {
    for (const preset of TERMINAL_FONT_FAMILY_PRESETS) {
      const families = splitFontFamilies(preset.css);

      expect(families, `${preset.id} xterm measurement stack`).not.toContain(symbolsFamily);
      expect(families.length, `${preset.id} has a text font`).toBeGreaterThan(0);
    }
  });

  it("resolves every xterm-measured preset without the DOM-only symbols face", () => {
    for (const preset of TERMINAL_FONT_FAMILY_PRESETS) {
      const families = splitFontFamilies(resolveTerminalFontFamily(preset.id));

      expect(families, `${preset.id} resolved xterm stack`).not.toContain(symbolsFamily);
      expect(families.length, `${preset.id} resolved text font`).toBeGreaterThan(0);
    }
  });
});
