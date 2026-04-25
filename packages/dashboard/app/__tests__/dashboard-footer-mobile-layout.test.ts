import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Stylesheet regression test for FN-824: Mobile footer-safe layout.
 *
 * Parses `packages/dashboard/app/styles.css` and asserts that the mobile
 * `@media (max-width: 768px)` rules for `.board` do NOT use viewport-height
 * sizing (`100vh` / `100dvh`) that would bypass the
 * `.project-content--with-footer` padding contract.
 *
 * ## Why this matters
 *
 * `.project-content--with-footer` reserves space for the fixed
 * `ExecutorStatusBar` footer via `padding-bottom: var(--executor-footer-height)`.
 * If `.board` sizes itself using `calc(100dvh - X)` instead of filling its
 * parent with `height: 100%`, the board extends beneath the footer bar,
 * making the bottom cards partially hidden and untappable on mobile.
 *
 * This test ensures no future change reintroduces viewport-height sizing
 * for the mobile board.
 */

describe("dashboard-footer-mobile-layout", () => {
  const cssContent = loadAllAppCss();

  /** Extract all content inside @media (max-width: 768px) blocks. */
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

  const mobileCss = extractMobileMediaBlocks(cssContent);

  // ── Board must NOT use viewport-height sizing ────────────────────────

  it("mobile .board does not use calc(100dvh - ...) for height", () => {
    // This was the FN-824 bug: mobile board had height: calc(100dvh - 57px)
    // which ignored the footer-safe wrapper's padding-bottom reservation.
    const hasDvhCalc = mobileCss.match(
      /\.board\s*\{[^}]*height\s*:\s*calc\s*\(\s*100dvh/,
    );
    expect(hasDvhCalc).toBeNull();
  });

  it("mobile .board does not use calc(100vh - ...) for height", () => {
    const hasVhCalc = mobileCss.match(
      /\.board\s*\{[^}]*height\s*:\s*calc\s*\(\s*100vh/,
    );
    expect(hasVhCalc).toBeNull();
  });

  it("mobile .board does not use 100dvh or 100vh directly for height", () => {
    const hasDirectVh = mobileCss.match(
      /\.board\s*\{[^}]*height\s*:\s*100dvh/,
    );
    const hasDirectVh2 = mobileCss.match(
      /\.board\s*\{[^}]*height\s*:\s*100vh/,
    );
    expect(hasDirectVh).toBeNull();
    expect(hasDirectVh2).toBeNull();
  });

  // ── Footer-safe wrapper contract ─────────────────────────────────────

  it("mobile .project-content--with-footer sets a footer height token", () => {
    // The mobile media query should override the footer height token
    expect(mobileCss).toMatch(
      /\.project-content--with-footer\s*\{[^}]*--executor-footer-height/,
    );
  });

  it("desktop .project-content--with-footer uses padding-bottom for footer space", () => {
    // Verify the desktop rule exists and uses the variable
    const desktopMatch = cssContent.match(
      /\.project-content--with-footer\s*\{[^}]*padding-bottom\s*:\s*var\(--executor-footer-height\)/,
    );
    expect(desktopMatch).not.toBeNull();
  });

  it("desktop .project-content--with-footer sets --executor-footer-height to a non-zero value", () => {
    const desktopMatch = cssContent.match(
      /\.project-content--with-footer\s*\{[^}]*--executor-footer-height:\s*([0-9]+px)/,
    );
    expect(desktopMatch).not.toBeNull();
    const value = desktopMatch![1];
    expect(value).not.toBe("0px");
  });
});
