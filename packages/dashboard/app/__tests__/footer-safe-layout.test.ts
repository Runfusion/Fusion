import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Stylesheet regression tests for the footer-safe project workspace layout.
 *
 * These tests lock in the layout contract where the `.project-content--with-footer`
 * wrapper is the single source of truth for reserving `ExecutorStatusBar` space.
 * Child views (board, list-view, agents-view) use `height: 100%` and rely on the
 * wrapper's padding-bottom to avoid rendering content beneath the fixed footer.
 */

const cssPath = resolve(__dirname, "../styles.css");
const css = readFileSync(cssPath, "utf-8");

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

describe("footer-safe project workspace layout", () => {
  // ── .project-content base ──────────────────────────────────────────

  describe(".project-content base rules", () => {
    it("has flex: 1 to fill remaining viewport space", () => {
      expect(css).toMatch(/\.project-content\s*\{[^}]*flex:\s*1/);
    });

    it("has min-height: 0 to allow flex shrinking", () => {
      expect(css).toMatch(/\.project-content\s*\{[^}]*min-height:\s*0/);
    });

    it("has overflow: hidden to clip content", () => {
      expect(css).toMatch(/\.project-content\s*\{[^}]*overflow:\s*hidden/);
    });
  });

  // ── .project-content--with-footer (desktop) ────────────────────────

  describe(".project-content--with-footer desktop", () => {
    const footerBlock = css.match(
      /\.project-content--with-footer\s*\{[^}]*\}/,
    )?.[0];

    it("defines --executor-footer-height token as 36px", () => {
      expect(footerBlock).toContain("--executor-footer-height: 36px");
    });

    it("reserves footer space with padding-bottom using the token", () => {
      expect(footerBlock).toContain(
        "padding-bottom: var(--executor-footer-height)",
      );
    });
  });

  // ── .project-content--with-footer (mobile) ─────────────────────────

  describe(".project-content--with-footer mobile", () => {
    const mobileCss = extractMobileMediaBlocks(css);

    it("overrides footer height token to 32px on mobile", () => {
      expect(mobileCss).toMatch(
        /\.project-content--with-footer\s*\{[^}]*--executor-footer-height:\s*32px/,
      );
    });
  });

  // ── Child views use height: 100% ───────────────────────────────────

  describe("child views use height: 100% (not viewport calc)", () => {
    it(".board uses height: 100%", () => {
      const boardBlock = css.match(/\.board\s*\{[^}]*\}/)?.[0];
      expect(boardBlock).toBeTruthy();
      expect(boardBlock).toContain("height: 100%");
      // Should NOT have viewport-based calc
      expect(boardBlock).not.toContain("100vh");
    });

    it(".list-view uses height: 100%", () => {
      const listBlock = css.match(/\.list-view\s*\{[^}]*\}/)?.[0];
      expect(listBlock).toBeTruthy();
      expect(listBlock).toContain("height: 100%");
      // Should NOT have viewport-based calc
      expect(listBlock).not.toContain("100vh");
    });
  });

  // ── ExecutorStatusBar remains fixed ────────────────────────────────

  describe("ExecutorStatusBar fixed footer preserved", () => {
    it("has position: fixed", () => {
      expect(css).toMatch(
        /\.executor-status-bar\s*\{[^}]*position:\s*fixed/,
      );
    });

    it("is anchored to bottom: 0", () => {
      expect(css).toMatch(
        /\.executor-status-bar\s*\{[^}]*bottom:\s*0/,
      );
    });

    it("has z-index for layering above content", () => {
      expect(css).toMatch(
        /\.executor-status-bar\s*\{[^}]*z-index:\s*\d+/,
      );
    });

    it("has explicit height: 36px on desktop", () => {
      expect(css).toMatch(
        /\.executor-status-bar\s*\{[^}]*height:\s*36px/,
      );
    });

    it("has height: 32px on mobile", () => {
      const mobileCss = extractMobileMediaBlocks(css);
      expect(mobileCss).toMatch(
        /\.executor-status-bar\s*\{[^}]*height:\s*32px/,
      );
    });
  });
});
