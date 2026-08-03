import { describe, it, expect } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../test/cssFixture";
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

const css = loadAllAppCss();

/** Extract all content inside @media (max-width: 768px) blocks. */
function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media[^{]*\(max-width: 768px\)[^{]*\{/g;
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
    /*
    FNXC:ViewportChrome 2026-08-03-00:13:
    Match the unscoped base rule only. Mode-scoped overrides
    (`html[data-viewport-mode=…] .project-content--with-footer`) also contain the
    class name and would otherwise win a first-match scan. Require both the 36px
    token and padding-bottom so token-only mode overrides cannot satisfy this contract.
    */
    const baseCss = loadAllAppCssBaseOnly();
    const footerBlock = [...baseCss.matchAll(/\.project-content--with-footer\s*\{[^}]*\}/g)]
      .map((match) => match[0])
      .find(
        (block) =>
          block.includes("--executor-footer-height: 36px") &&
          block.includes("padding-bottom: var(--executor-footer-height)") &&
          !block.includes("data-viewport-mode"),
      );

    it("defines --executor-footer-height token as 36px", () => {
      expect(footerBlock).toBeTruthy();
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

    it("overrides footer height token to mobile touch-safe size", () => {
      expect(mobileCss).toMatch(
        /\.project-content--with-footer\s*\{[^}]*--executor-footer-height:\s*calc\(var\(--space-lg\)\s*\*\s*2\s*\+\s*var\(--space-xs\)\)/,
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

    it("agents mobile content does not re-add mobile nav height already reserved by wrapper", () => {
      const mobileCss = extractMobileMediaBlocks(css);
      const agentsContentBlock = mobileCss.match(/\.agents-view-content\s*\{[^}]*\}/)?.[0] ?? "";

      expect(agentsContentBlock).toContain("padding: var(--space-md) var(--space-md) calc(var(--space-md) + env(safe-area-inset-bottom, 0px) + var(--standalone-bottom-gap));");
      expect(agentsContentBlock).not.toContain("var(--mobile-nav-height)");
    });
  });

  // ── ExecutorStatusBar remains fixed ────────────────────────────────

  describe("ExecutorStatusBar fixed footer preserved", () => {
    it("has position: fixed", () => {
      expect(css).toMatch(
        /\.executor-status-bar\s*\{[^}]*position:\s*fixed/,
      );
    });

    it("is anchored to bottom via ICB offset token", () => {
      expect(css).toMatch(
        /\.executor-status-bar\s*\{[^}]*bottom:\s*var\(--icb-bottom-offset/,
      );
    });

    it("has z-index for layering above content", () => {
      expect(css).toMatch(
        /\.executor-status-bar\s*\{[^}]*z-index:\s*\d+/,
      );
    });

    it("on mobile, positions above the mobile nav bar using nav-height contract", () => {
      const mobileCss = extractMobileMediaBlocks(css);
      expect(mobileCss).toMatch(
        /\.executor-status-bar\s*\{[^}]*bottom:[^}]*var\(--mobile-nav-height\)/,
      );
    });

    it("has explicit height: 36px on desktop", () => {
      expect(css).toMatch(
        /\.executor-status-bar\s*\{[^}]*height:\s*36px/,
      );
    });

    it("has touch-safe height on mobile", () => {
      const mobileCss = extractMobileMediaBlocks(css);
      expect(mobileCss).toMatch(
        /\.executor-status-bar\s*\{[^}]*height:\s*calc\(var\(--space-lg\)\s*\*\s*2\s*\+\s*var\(--space-xs\)\)/,
      );
    });
  });
});
