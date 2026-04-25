import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import fs from "fs";
import path from "path";

/**
 * Theme-safety regression tests for status color tokens across
 * TaskCard, GitHubBadge, and PrSection components.
 *
 * These tests verify that hardcoded rgba/hex colors have been replaced
 * with theme-aware CSS custom properties using color-mix(), ensuring
 * correct rendering across all 31 color themes and both light/dark modes.
 */

describe("Status color CSS custom properties", () => {
  let css: string;

  beforeAll(() => {
    css = loadAllAppCss();
  });

  it("defines --status-triage-bg custom property in :root using color-mix()", () => {
    const rootBlock = extractRootBlock(css);
    expect(rootBlock).toContain("--status-triage-bg");
    expect(rootBlock).toContain("color-mix(in srgb, var(--triage) 15%, transparent)");
  });

  it("defines --status-todo-bg custom property in :root using color-mix()", () => {
    const rootBlock = extractRootBlock(css);
    expect(rootBlock).toContain("--status-todo-bg");
    expect(rootBlock).toContain("color-mix(in srgb, var(--todo) 15%, transparent)");
  });

  it("defines --status-in-progress-bg custom property in :root using color-mix()", () => {
    const rootBlock = extractRootBlock(css);
    expect(rootBlock).toContain("--status-in-progress-bg");
    expect(rootBlock).toContain("color-mix(in srgb, var(--in-progress) 15%, transparent)");
  });

  it("defines --status-in-review-bg custom property in :root using color-mix()", () => {
    const rootBlock = extractRootBlock(css);
    expect(rootBlock).toContain("--status-in-review-bg");
    expect(rootBlock).toContain("color-mix(in srgb, var(--in-review) 15%, transparent)");
  });

  it("defines --status-done-bg custom property in :root using color-mix()", () => {
    const rootBlock = extractRootBlock(css);
    expect(rootBlock).toContain("--status-done-bg");
    expect(rootBlock).toContain("color-mix(in srgb, var(--done) 15%, transparent)");
  });

  it("defines --status-error-bg custom property in :root using color-mix()", () => {
    const rootBlock = extractRootBlock(css);
    expect(rootBlock).toContain("--status-error-bg");
    expect(rootBlock).toContain("color-mix(in srgb, var(--color-error-dark");
  });

  it("defines --status-archived-bg custom property in :root using color-mix()", () => {
    const rootBlock = extractRootBlock(css);
    expect(rootBlock).toContain("--status-archived-bg");
    expect(rootBlock).toContain("color-mix(in srgb, var(--text-muted");
  });

  it("defines --surface-hover in :root using semantic color-mix()", () => {
    const rootBlock = extractRootBlock(css);
    expect(rootBlock).toContain("--surface-hover");
    expect(rootBlock).toContain(
      "--surface-hover: color-mix(in srgb, var(--surface) 90%, var(--text) 10%)"
    );
  });

  it("defines light theme override for --surface-hover", () => {
    const lightBlock = extractLightThemeBlock(css);
    expect(lightBlock).toContain("--surface-hover");
    expect(lightBlock).toContain(
      "--surface-hover: color-mix(in srgb, var(--surface) 92%, var(--text) 8%)"
    );
  });

  it("defines semantic neutral surface tiers in :root", () => {
    const rootBlock = extractRootBlock(css);
    expect(rootBlock).toContain("--surface-subtle");
    expect(rootBlock).toContain("--surface-muted");
    expect(rootBlock).toContain("--surface-emphasis");
    expect(rootBlock).toContain("--surface-hover-strong");
  });

  it("defines semantic neutral surface tier overrides in light theme", () => {
    const lightBlock = extractLightThemeBlock(css);
    expect(lightBlock).toContain("--surface-subtle");
    expect(lightBlock).toContain("--surface-muted");
    expect(lightBlock).toContain("--surface-emphasis");
    expect(lightBlock).toContain("--surface-hover-strong");
  });

  it("defines semantic neutral tiers with tokenized color-mix expressions", () => {
    expect(css).toMatch(/--surface-subtle:\s*color-mix\(in\s+srgb,\s*var\(--surface\)\s+96%,\s*var\(--text\)\s+4%\)/);
    expect(css).toMatch(/--surface-muted:\s*color-mix\(in\s+srgb,\s*var\(--surface\)\s+94%,\s*var\(--text\)\s+6%\)/);
    expect(css).toMatch(/--surface-emphasis:\s*color-mix\(in\s+srgb,\s*var\(--surface\)\s+92%,\s*var\(--text\)\s+8%\)/);
    expect(css).toMatch(/--surface-hover-strong:\s*color-mix\(in\s+srgb,\s*var\(--surface\)\s+88%,\s*var\(--text\)\s+12%\)/);
    expect(css).not.toMatch(/--surface-(subtle|muted|emphasis|hover-strong):\s*rgba\(/);
  });

  it("uses --surface-hover without per-rule fallback overrides", () => {
    expect(css).toContain("var(--surface-hover)");
    expect(css).not.toContain("var(--surface-hover,");
    expect(css).not.toMatch(/var\(--surface-hover,\s*rgba\(/);
  });

  it("defines --surface-hover with tokenized color-mix (no raw rgba/hex)", () => {
    expect(css).toMatch(/--surface-hover:\s*color-mix\(in\s+srgb,\s*var\(--surface\)\s+90%,\s*var\(--text\)\s+10%\)/);
    expect(css).toMatch(/\[data-theme="light"\]\s*\{[^}]*--surface-hover:\s*color-mix\(in\s+srgb,\s*var\(--surface\)\s+92%,\s*var\(--text\)\s+8%\)/s);
    expect(css).not.toMatch(/--surface-hover:\s*rgba\(/);
    expect(css).not.toMatch(/--surface-hover:\s*#[0-9a-fA-F]{3,8}/);
  });

  it("defines light theme override for --status-error-bg", () => {
    const lightBlock = extractLightThemeBlock(css);
    expect(lightBlock).toContain("--status-error-bg");
    expect(lightBlock).toContain("--status-error-bg-deep");
  });
});

describe("TaskCard theme safety", () => {
  const componentPath = path.resolve(__dirname, "../components/TaskCard.tsx");
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(componentPath, "utf-8");
  });

  it("does not contain COLUMN_COLOR_MAP with hardcoded rgba colors", () => {
    expect(source).not.toContain("COLUMN_COLOR_MAP");
    expect(source).not.toContain("rgba(210,153,34");
    expect(source).not.toContain("rgba(88,166,255");
    expect(source).not.toContain("rgba(188,140,255");
    expect(source).not.toContain("rgba(63,185,80");
    expect(source).not.toContain("rgba(139,148,158");
    expect(source).not.toContain("rgba(120,120,120");
  });

  it("does not contain hardcoded paused badge color rgba(139,148,158,0.2)", () => {
    expect(source).not.toContain("rgba(139,148,158");
  });

  it("does not contain hardcoded failed badge colors", () => {
    expect(source).not.toContain("rgba(218,54,51");
    expect(source).not.toContain("#da3633");
  });

  it("does not contain hardcoded awaiting-approval badge color", () => {
    expect(source).not.toContain("rgba(210,153,34,0.2)");
  });

  it("uses CSS classes for status badges instead of inline styles", () => {
    // Should use card-status-badge--${column} pattern
    expect(source).toContain("card-status-badge--");
    // Should use paused class
    expect(source).toContain('"card-status-badge paused"');
  });

  it("does not contain hardcoded hex colors in inline styles", () => {
    // No raw #rrggbb or #rgb hex values in the component source
    const hexPattern = /"[^"]*#[0-9a-fA-F]{3,8}[^"]*"/g;
    const matches = source.match(hexPattern);
    expect(
      matches,
      `Found hardcoded hex colors in TaskCard.tsx: ${matches}`
    ).toBeNull();
  });
});

describe("GitHubBadge theme safety", () => {
  const componentPath = path.resolve(__dirname, "../components/GitHubBadge.tsx");
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(componentPath, "utf-8");
  });

  it("does not contain COLORS object with hardcoded rgba values", () => {
    expect(source).not.toContain("COLORS");
    expect(source).not.toContain("rgba(63,185,80");
    expect(source).not.toContain("rgba(218,54,51");
    expect(source).not.toContain("rgba(188,140,255");
    expect(source).not.toContain("rgba(248,81,73");
    expect(source).not.toContain("rgba(139,148,158");
  });

  it("does not contain hardcoded hex colors", () => {
    expect(source).not.toContain("#3fb950");
    expect(source).not.toContain("#da3633");
    expect(source).not.toContain("#bc8cff");
    expect(source).not.toContain("#f85149");
    expect(source).not.toContain("#8b949e");
  });

  it("does not use getPrColors or getIssueColors helpers", () => {
    expect(source).not.toContain("getPrColors");
    expect(source).not.toContain("getIssueColors");
  });

  it("does not use inline style props for badge coloring", () => {
    // Should not have style={{ background: or style={{ color: in badge spans
    expect(source).not.toMatch(/style=\{\{[^}]*background:/);
    expect(source).not.toMatch(/style=\{\{[^}]*color:/);
  });
});

describe("PrSection theme safety", () => {
  const componentPath = path.resolve(__dirname, "../components/PrSection.tsx");
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(componentPath, "utf-8");
  });

  it("does not contain STATUS_COLORS with hardcoded rgba values", () => {
    expect(source).not.toContain("STATUS_COLORS");
    expect(source).not.toContain("rgba(63,185,80");
    expect(source).not.toContain("rgba(218,54,51");
    expect(source).not.toContain("rgba(188,140,255");
  });

  it("does not contain hardcoded hex colors", () => {
    expect(source).not.toContain("#3fb950");
    expect(source).not.toContain("#da3633");
    expect(source).not.toContain("#bc8cff");
  });

  it("uses CSS modifier classes for PR status badges", () => {
    expect(source).toContain("pr-status-badge--");
    expect(source).toContain("pr-card--status-");
  });
});

describe("CSS modifier classes for status colors", () => {
  let css: string;

  beforeAll(() => {
    css = loadAllAppCss();
  });

  it("defines card-status-badge modifier classes for all columns", () => {
    expect(css).toContain(".card-status-badge--triage");
    expect(css).toContain(".card-status-badge--todo");
    expect(css).toContain(".card-status-badge--in-progress");
    expect(css).toContain(".card-status-badge--in-review");
    expect(css).toContain(".card-status-badge--done");
    expect(css).toContain(".card-status-badge--archived");
  });

  it("defines card-status-badge modifier classes for paused and awaiting-approval", () => {
    expect(css).toContain(".card-status-badge.paused");
    expect(css).toContain(".card-status-badge.awaiting-approval");
  });

  it("defines GitHub badge modifier classes", () => {
    expect(css).toContain(".card-github-badge--open");
    expect(css).toContain(".card-github-badge--closed");
    expect(css).toContain(".card-github-badge--merged");
    expect(css).toContain(".card-github-badge--completed");
    expect(css).toContain(".card-github-badge--not-planned");
  });

  it("defines PR status badge modifier classes", () => {
    expect(css).toContain(".pr-status-badge--open");
    expect(css).toContain(".pr-status-badge--closed");
    expect(css).toContain(".pr-status-badge--merged");
  });

  it("defines PR card status modifier classes", () => {
    expect(css).toContain(".pr-card--status-open");
    expect(css).toContain(".pr-card--status-closed");
    expect(css).toContain(".pr-card--status-merged");
  });

  it("uses var() tokens in all status modifier classes", () => {
    const modifierBlocks = [
      ".card-status-badge--triage",
      ".card-status-badge--todo",
      ".card-status-badge--in-progress",
      ".card-status-badge--in-review",
      ".card-status-badge--done",
    ];

    for (const selector of modifierBlocks) {
      const blockStart = css.indexOf(selector);
      expect(blockStart, `Missing selector: ${selector}`).toBeGreaterThan(-1);

      const block = css.slice(blockStart, blockStart + 300);
      // Split at } to get just this block
      const blockEnd = block.indexOf("}");
      const blockContent = block.slice(0, blockEnd);

      expect(
        blockContent.includes("var(--"),
        `${selector} should use var() tokens but got: ${blockContent}`
      ).toBe(true);
    }
  });

  it("card-status-badge.failed uses --status-error-bg token", () => {
    const failedIdx = css.indexOf(".card-status-badge.failed");
    expect(failedIdx).toBeGreaterThan(-1);
    const block = css.slice(failedIdx, failedIdx + 200);
    expect(block).toContain("var(--status-error-bg)");
  });

  it("card-status-badge.stuck uses --status-triage-bg-deep token", () => {
    const stuckIdx = css.indexOf(".card-status-badge.stuck");
    expect(stuckIdx).toBeGreaterThan(-1);
    const block = css.slice(stuckIdx, stuckIdx + 200);
    expect(block).toContain("var(--status-triage-bg-deep)");
  });
});

describe("Accent color per color theme", () => {
  // Theme blocks are now in a separate theme-data.css file
  const themeDataPath = path.resolve(__dirname, "../public/theme-data.css");
  let css: string;
  let themeData: string;

  beforeAll(() => {
    css = loadAllAppCss();
    themeData = fs.readFileSync(themeDataPath, "utf-8");
  });

  /**
   * Extract every dark color-theme block [data-color-theme="<name>"] { … }
   * (excludes light variants and compound selectors with spaces/dots).
   */
  function getDarkColorThemeBlocks(): Map<string, string> {
    const blocks = new Map<string, string>();
    const regex = /^\[data-color-theme="([^"]+)"\]\s*\{/gm;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(themeData)) !== null) {
      const themeName = match[1];
      // Skip if this is actually a light variant or compound selector
      const fullLine = themeData.slice(match.index, themeData.indexOf("\n", match.index));
      if (fullLine.includes("[data-theme=") || fullLine.includes(".") || fullLine.includes(",")) {
        continue;
      }

      const openBraceIdx = match.index + match[0].length - 1;
      let depth = 1;
      let end = openBraceIdx;
      for (let i = openBraceIdx + 1; i < themeData.length; i++) {
        if (themeData[i] === "{") depth++;
        if (themeData[i] === "}") depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
      blocks.set(themeName, themeData.slice(match.index, end + 1));
    }
    return blocks;
  }

  /**
   * Extract every light color-theme block [data-color-theme="<name>"][data-theme="light"] { … }
   */
  function getLightColorThemeBlocks(): Map<string, string> {
    const blocks = new Map<string, string>();
    const regex = /^\[data-color-theme="([^"]+)"\]\[data-theme="light"\]\s*\{/gm;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(themeData)) !== null) {
      const themeName = match[1];
      const openBraceIdx = match.index + match[0].length - 1;
      let depth = 1;
      let end = openBraceIdx;
      for (let i = openBraceIdx + 1; i < themeData.length; i++) {
        if (themeData[i] === "{") depth++;
        if (themeData[i] === "}") depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
      blocks.set(themeName, themeData.slice(match.index, end + 1));
    }
    return blocks;
  }

  it("every dark color theme block defines --accent", () => {
    const blocks = getDarkColorThemeBlocks();
    expect(blocks.size).toBeGreaterThanOrEqual(34);

    const missing: string[] = [];
    for (const [theme, block] of blocks) {
      if (!block.includes("--accent:")) {
        missing.push(theme);
      }
    }

    expect(missing, `Dark themes missing --accent: ${missing.join(", ")}`).toEqual([]);
  });

  it("every light color theme block defines --accent", () => {
    const blocks = getLightColorThemeBlocks();
    expect(blocks.size).toBeGreaterThanOrEqual(34);

    const missing: string[] = [];
    for (const [theme, block] of blocks) {
      if (!block.includes("--accent:")) {
        missing.push(theme);
      }
    }

    expect(missing, `Light themes missing --accent: ${missing.join(", ")}`).toEqual([]);
  });

  it("dark and light accent counts match color theme counts", () => {
    const darkBlocks = getDarkColorThemeBlocks();
    const lightBlocks = getLightColorThemeBlocks();

    const darkAccentCount = Array.from(darkBlocks.values()).filter(b => b.includes("--accent:")).length;
    const lightAccentCount = Array.from(lightBlocks.values()).filter(b => b.includes("--accent:")).length;

    expect(darkAccentCount).toBe(darkBlocks.size);
    expect(lightAccentCount).toBe(lightBlocks.size);
  });

  it("every dark color theme block defines --surface-hover using tokenized color-mix", () => {
    const blocks = getDarkColorThemeBlocks();
    expect(blocks.size).toBeGreaterThanOrEqual(34);

    const missing: string[] = [];
    const invalid: string[] = [];

    for (const [theme, block] of blocks) {
      if (!block.includes("--surface-hover:")) {
        missing.push(theme);
        continue;
      }
      if (
        !block.includes("--surface-hover: color-mix(in srgb, var(--surface) 90%, var(--text) 10%)") ||
        /--surface-hover:\s*(rgba\(|#[0-9a-fA-F]{3,8})/.test(block)
      ) {
        invalid.push(theme);
      }
    }

    expect(missing, `Dark themes missing --surface-hover: ${missing.join(", ")}`).toEqual([]);
    expect(invalid, `Dark themes with non-tokenized --surface-hover: ${invalid.join(", ")}`).toEqual([]);
  });

  it("every light color theme block defines --surface-hover using tokenized color-mix", () => {
    const blocks = getLightColorThemeBlocks();
    expect(blocks.size).toBeGreaterThanOrEqual(34);

    const missing: string[] = [];
    const invalid: string[] = [];

    for (const [theme, block] of blocks) {
      if (!block.includes("--surface-hover:")) {
        missing.push(theme);
        continue;
      }
      if (
        !block.includes("--surface-hover: color-mix(in srgb, var(--surface) 92%, var(--text) 8%)") ||
        /--surface-hover:\s*(rgba\(|#[0-9a-fA-F]{3,8})/.test(block)
      ) {
        invalid.push(theme);
      }
    }

    expect(missing, `Light themes missing --surface-hover: ${missing.join(", ")}`).toEqual([]);
    expect(invalid, `Light themes with non-tokenized --surface-hover: ${invalid.join(", ")}`).toEqual([]);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function extractRootBlock(css: string): string {
  // Find the second :root block (the one with status tokens)
  const rootRegex = /:root\s*\{/g;
  let match;
  let secondRootIdx = -1;
  let count = 0;

  while ((match = rootRegex.exec(css)) !== null) {
    count++;
    if (count === 2) {
      secondRootIdx = match.index;
      break;
    }
  }

  if (secondRootIdx === -1) {
    throw new Error("Could not find second :root block");
  }

  // Find the opening brace position
  const openBraceIdx = secondRootIdx + css.slice(secondRootIdx).indexOf("{");

  // Start depth at 1 since we're already inside the block
  let depth = 1;
  let end = openBraceIdx;
  for (let i = openBraceIdx + 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }

  return css.slice(secondRootIdx, end + 1);
}

function extractLightThemeBlock(css: string): string {
  const startMatch = css.match(/\[data-theme="light"\]\s*\{/);
  if (!startMatch) {
    throw new Error("Could not find [data-theme=\"light\"] block");
  }

  const startIdx = startMatch.index!;
  const openBraceIdx = startIdx + css.slice(startIdx).indexOf("{");

  let depth = 1;
  let end = openBraceIdx;
  for (let i = openBraceIdx + 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }

  return css.slice(startIdx, end + 1);
}
