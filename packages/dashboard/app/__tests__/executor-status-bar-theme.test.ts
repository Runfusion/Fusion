import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Stylesheet regression tests for executor status bar theme-token compliance.
 *
 * These tests verify that the executor footer's error state background
 * uses semantic CSS custom properties (`--executor-status-error-bg`) instead of
 * hardcoded RGBA color literals, so the footer adapts to every color theme and
 * light/dark mode without manual overrides.
 *
 * The running state no longer applies a visual background — the footer uses a
 * neutral background regardless of executor state.
 *
 * These checks complement (not replace) `footer-safe-layout.test.ts`, which
 * validates the layout contract (fixed positioning, height tokens, padding).
 */

const css = loadAllAppCss();

/** Extract a CSS rule block by selector (handles multiline). */
function extractRule(content: string, selector: string): string | null {
  // Escape special chars in selector for regex
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s");
  const match = content.match(regex);
  return match?.[1] ?? null;
}

/** Extract the content of a named @media block. */
function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let endIdx = startIdx;
    while (braceCount > 0 && endIdx < content.length) {
      if (content[endIdx] === "{") braceCount++;
      if (content[endIdx] === "}") braceCount--;
      endIdx++;
    }
    if (braceCount === 0) {
      blocks.push(content.slice(startIdx, endIdx - 1));
    }
  }
  return blocks.join("\n");
}

// ── Token definitions ──────────────────────────────────────────────

describe("executor status bar state tokens", () => {
  describe(":root (dark theme defaults)", () => {
    it("defines --executor-status-error-bg token using color-mix at 8%", () => {
      expect(css).toMatch(
        /--executor-status-error-bg:\s*color-mix\(in\s+srgb,\s*var\(--color-error\)\s+8%,\s*transparent\)/,
      );
    });
  });

  describe('[data-theme="light"] overrides', () => {
    it("overrides --executor-status-error-bg to 6% intensity", () => {
      expect(css).toMatch(
        /\[data-theme="light"\]\s*\{[^}]*--executor-status-error-bg:\s*color-mix\(in\s+srgb,\s*var\(--color-error\)\s+6%,\s*transparent\)/s,
      );
    });
  });
});

// ── State rule usage ───────────────────────────────────────────────

describe("executor status bar state rules reference tokens", () => {
  it(".executor-status-bar--error uses the error-bg token as solid background", () => {
    const errorBlock = extractRule(css, ".executor-status-bar--error");
    expect(errorBlock).toBeTruthy();
    expect(errorBlock!).toMatch(/background:\s*var\(--executor-status-error-bg\)/);
    expect(errorBlock!).not.toMatch(/rgba\(/);
  });
});

// ── No hardcoded RGBA literals in footer state blocks ──────────────

describe("no hardcoded RGBA literals in executor footer state rules", () => {
  it("error state rules contain no hardcoded red RGBA literals", () => {
    const errorMatches = css.matchAll(
      /\.executor-status-bar--error\s*\{[^}]*\}/gs,
    );
    for (const match of errorMatches) {
      expect(match[0]).not.toMatch(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,/);
    }
  });
});

// ── Light theme does not override running/error selectors directly ──

describe("light theme uses tokens instead of direct selector overrides", () => {
  it("has no [data-theme='light'] .executor-status-bar--running rule", () => {
    expect(css).not.toMatch(
      /\[data-theme="light"\]\s*\.executor-status-bar--running\s*\{/,
    );
  });

  it("has no [data-theme='light'] .executor-status-bar--error rule", () => {
    expect(css).not.toMatch(
      /\[data-theme="light"\]\s*\.executor-status-bar--error\s*\{/,
    );
  });
});

// ── Gradient structure preserved ───────────────────────────────────

describe("running state gradient structure", () => {
  it("running state has no dedicated CSS rule (neutral footer)", () => {
    const runningBlock = extractRule(css, ".executor-status-bar--running");
    expect(runningBlock).toBeNull();
  });

  it("error state uses flat fill (no gradient)", () => {
    const errorBlock = extractRule(css, ".executor-status-bar--error");
    expect(errorBlock).toBeTruthy();
    expect(errorBlock!).not.toContain("linear-gradient");
  });
});

// ── Relationship to footer-safe-layout tests ───────────────────────

describe("complementary test coverage note", () => {
  it("this test file is distinct from footer-safe-layout.test.ts", () => {
    // This is a documentation assertion: the footer-safe-layout tests cover
    // positioning, height, and padding, while these tests cover color theming.
    // Both test suites should coexist.
    expect(__filename).toContain("executor-status-bar-theme");
    expect(__filename).not.toContain("footer-safe-layout");
  });
});
