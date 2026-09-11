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
    it(".board and every workflow state fill the parent-defined safe height", () => {
      const boardBlock = css.match(/\.board\s*\{[^}]*\}/)?.[0] ?? "";
      const workflowViewBlock = css.match(/\.board-workflow-view\s*\{[^}]*\}/)?.[0] ?? "";
      const skeletonBlock = css.match(/\.board\.board-workflows-skeleton\s*\{[^}]*\}/)?.[0] ?? "";
      expect(boardBlock).toContain("height: 100%");
      expect(boardBlock).toContain("min-height: 0");
      expect(workflowViewBlock).toContain("height: 100%");
      expect(workflowViewBlock).toContain("min-height: 0");
      expect(skeletonBlock).toContain("height: 100%");
      expect(skeletonBlock).toContain("min-height: 0");
      expect(`${boardBlock}${workflowViewBlock}${skeletonBlock}`).not.toMatch(/100d?vh/);
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

  // ── Footer-height token consumers outside the declaring scope ──────

  /*
  FNXC:DashboardFooterLayout 2026-09-11-23:41:
  `:root` floors --executor-footer-height at 0px (styles.css) and only
  .dashboard-project-shell / .project-content--with-footer raise it to 36px.
  A bottom-edge surface rendered OUTSIDE those scopes therefore inherits 0px.
  That silently collapsed the Alpha desktop navigation footer to zero height:
  mounted and focusable, but invisible, after it had already replaced the left
  sidebar. Assert the general invariant rather than that one bar — any rule that
  sizes its own box from the token must declare the token in the same block.
  */
  describe("--executor-footer-height consumers that size themselves", () => {
    // Comments carry braces and at-rule prose, so strip them before parsing rules.
    const baseCss = loadAllAppCssBaseOnly().replace(/\/\*[\s\S]*?\*\//g, "");
    const ruleBlocks = [...baseCss.matchAll(/(^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].map((match) => ({
      selector: match[2].trim(),
      body: match[3],
    }));

    it("floors the token at 0px on :root, which is what makes redeclaration mandatory", () => {
      expect(baseCss).toMatch(/:root\s*\{[^}]*--executor-footer-height:\s*0px/);
    });

    it("every rule sizing its own box from the token also declares the token", () => {
      const selfSizing = ruleBlocks.filter((rule) =>
        /(?:^|;|\s)(?:block-size|height):\s*var\(--executor-footer-height\b/.test(rule.body),
      );
      expect(selfSizing.length).toBeGreaterThan(0);
      const collapsingToZero = selfSizing
        .filter((rule) => !/--executor-footer-height:\s*(?!0px)[^;]+;/.test(rule.body))
        .map((rule) => rule.selector);
      expect(collapsingToZero).toEqual([]);
    });

    it("gives the Alpha desktop navigation footer a non-zero height outside the shell scope", () => {
      const bar = ruleBlocks.find((rule) => rule.selector === ".alpha-desktop-action-bar");
      expect(bar).toBeTruthy();
      expect(bar!.body).toContain("--executor-footer-height: 36px");
      expect(bar!.body).toContain("block-size: var(--executor-footer-height)");
    });

    it("keeps the sibling pinned-terminal host redeclaring the token for the same reason", () => {
      const host = ruleBlocks.find((rule) => rule.selector === ".terminal-below-host--with-footer");
      expect(host).toBeTruthy();
      expect(host!.body).toContain("--executor-footer-height: 36px");
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
