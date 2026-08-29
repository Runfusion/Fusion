import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import { readFileSync } from "fs";
import { resolve } from "path";

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media[^{]*\(max-width: 768px\)[^{]*\{/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let endIdx = startIdx;

    while (braceCount > 0 && endIdx < content.length) {
      if (content[endIdx] === "{") braceCount += 1;
      if (content[endIdx] === "}") braceCount -= 1;
      endIdx += 1;
    }

    if (braceCount === 0) {
      blocks.push(content.slice(startIdx, endIdx - 1));
    }
  }

  return blocks.join("\n");
}

describe("mobile-nav-bar.css", () => {
  const cssContent = loadAllAppCss();
  const mobileMediaBlock = extractMobileMediaBlocks(cssContent);

  it("tab bar has fixed position", () => {
    const block = extractRuleBlock(cssContent, ".mobile-nav-bar");
    expect(block).toContain("position: fixed");
    expect(block).toContain("bottom: var(--icb-bottom-offset, 0px)");
  });

  it("tab bar display toggles in mobile media query", () => {
    const block = extractRuleBlock(cssContent, ".mobile-nav-bar");
    expect(block).toContain("display: none");
    expect(cssContent).toContain("@media (max-width: 768px)");
    expect(cssContent).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.mobile-nav-bar\s*\{[\s\S]*?display:\s*flex[;\s]/);
  });

  it("tab touch targets are at least 36px", () => {
    const block = extractRuleBlock(cssContent, ".mobile-nav-tab");
    // FNXC:DashboardStyling 2026-06-20-20:56: FN-6809 keeps the 36px touch-target intent via tokens; --space-xl (24px) + --space-md (12px) resolves to the same min-height.
    expect(block).toContain("min-height: calc(var(--space-xl) + var(--space-md))");
  });

  it("footer-aware positioning keeps nav at bottom: 0 when footer is visible", () => {
    expect(cssContent).toContain(".mobile-nav-bar--with-footer");
    // Nav bar stays at bottom: 0 (no longer shifts up)
    // ExecutorStatusBar is positioned above via its own bottom offset
    expect(mobileMediaBlock).toContain(".mobile-nav-bar--with-footer");
    expect(mobileMediaBlock).toContain("bottom: var(--icb-bottom-offset, 0px)");
  });

  it("executor status bar has bottom offset above nav bar on mobile", () => {
    // ExecutorStatusBar mobile override positions it above the mobile nav bar
    // and includes safe-area + standalone token spacing in scoped rule.
    expect(mobileMediaBlock).toMatch(
      /\.executor-status-bar\s*\{[^}]*bottom:[^}]*var\(--mobile-nav-height\)/,
    );
  });

  it("defines bottom sheet animation", () => {
    expect(cssContent).toContain("@keyframes mobile-more-sheet-in");
  });

  it("uses safe-area inset for bottom spacing", () => {
    expect(cssContent).toContain("env(safe-area-inset-bottom");
  });

  it("tab bar keeps symmetric tokenized side spacing while preserving ICB compensation", () => {
    const block = extractRuleBlock(cssContent, ".mobile-nav-bar");
    expect(block).toContain("left: 0");
    expect(block).toContain("right: var(--icb-right-offset, 0px)");
    expect(block).toContain("padding-inline: var(--space-sm)");
    expect(block).toMatch(/padding-inline:\s*var\(--space-[^)]+\)/);
    expect(block).not.toMatch(/padding-left:\s*(?!0[;\s])/);
    expect(block).not.toMatch(/padding-right:\s*(?!0[;\s])/);
  });

  it("tab bar includes z-index", () => {
    const block = extractRuleBlock(cssContent, ".mobile-nav-bar");
    expect(block).toContain("z-index: 45");
  });

  it("sheet items maintain 36px touch targets", () => {
    const block = extractRuleBlock(cssContent, ".mobile-more-item");
    expect(block).toContain("min-height: 36px");
  });

  it("defines content padding rule for mobile nav", () => {
    expect(mobileMediaBlock).toContain(".project-content--with-mobile-nav");
    expect(cssContent).toContain(".project-content--with-footer.project-content--with-mobile-nav");
    expect(cssContent).toContain("var(--executor-footer-height)");
    expect(cssContent).toContain("env(safe-area-inset-bottom, 0px)");
    expect(cssContent).toContain("var(--standalone-bottom-gap)");
    expect(cssContent).not.toContain("calc(32px + var(--mobile-nav-height)");
  });

  it("mobile-more-sheet uses additive safe-area padding (not max) to prevent Settings clipping", () => {
    // FN-1545: The mobile More sheet bottom padding must ADD safe-area inset to the
    // base padding, not use max() which could collapse spacing on devices with large insets.
    // This ensures the Settings item at the bottom is fully reachable on real mobile viewports.
    const block = extractRuleBlock(cssContent, ".mobile-more-sheet");
    // Must contain calc() with + operator for additive safe-area handling
    expect(block).toMatch(/padding-bottom:\s*calc\([^)]+\s*\+\s*env\(safe-area-inset-bottom/);
    // Must NOT use max() which would replace rather than add
    expect(block).not.toContain("max(16px, env(safe-area-inset-bottom");
  });

  it("mobile-more-sheet has scrollable content to reach Settings on short viewports", () => {
    const block = extractRuleBlock(cssContent, ".mobile-more-sheet");
    // Must be scrollable so users can scroll to the last item (Settings)
    expect(block).toContain("overflow-y: auto");
    // Must have max-height to constrain but allow scrolling
    expect(block).toMatch(/max-height:\s*\d+vh/);
  });
});
