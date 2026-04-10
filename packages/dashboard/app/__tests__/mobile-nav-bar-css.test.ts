import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/g;
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
  const cssPath = resolve(__dirname, "../styles.css");
  const cssContent = readFileSync(cssPath, "utf-8");
  const mobileMediaBlock = extractMobileMediaBlocks(cssContent);

  it("tab bar has fixed position", () => {
    const block = extractRuleBlock(cssContent, ".mobile-nav-bar");
    expect(block).toContain("position: fixed");
    expect(block).toContain("bottom: 0");
  });

  it("tab bar display toggles in mobile media query", () => {
    const block = extractRuleBlock(cssContent, ".mobile-nav-bar");
    expect(block).toContain("display: none");
    expect(cssContent).toContain("@media (max-width: 768px)");
    expect(cssContent).toMatch(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.mobile-nav-bar\s*\{[\s\S]*?display:\s*flex[;\s]/);
  });

  it("tab touch targets are at least 36px", () => {
    const block = extractRuleBlock(cssContent, ".mobile-nav-tab");
    expect(block).toContain("min-height: 36px");
  });

  it("footer-aware positioning keeps nav at bottom: 0 when footer is visible", () => {
    expect(cssContent).toContain(".mobile-nav-bar--with-footer");
    // Nav bar stays at bottom: 0 (no longer shifts up)
    // ExecutorStatusBar is positioned above via its own bottom offset
    expect(mobileMediaBlock).toContain(".mobile-nav-bar--with-footer");
    expect(mobileMediaBlock).toContain("bottom: 0");
  });

  it("executor status bar has bottom offset above nav bar on mobile", () => {
    // ExecutorStatusBar mobile override positions it above the mobile nav bar
    expect(mobileMediaBlock).toMatch(
      /\.executor-status-bar\s*\{[^}]*bottom:\s*calc\(48px/,
    );
  });

  it("defines bottom sheet animation", () => {
    expect(cssContent).toContain("@keyframes mobile-more-sheet-in");
  });

  it("uses safe-area inset for bottom spacing", () => {
    expect(cssContent).toContain("env(safe-area-inset-bottom");
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
  });
});
