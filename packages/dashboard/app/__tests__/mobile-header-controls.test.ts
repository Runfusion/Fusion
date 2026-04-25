import { describe, it, expect } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../test/cssFixture";

/**
 * Stylesheet regression test for mobile header controls.
 *
 * This test verifies that the CSS file contains the necessary mobile
 * header selectors and rules for:
 * - Collapsed search trigger (.mobile-search-trigger)
 * - Expanded mobile search panel (.mobile-search-expanded)
 * - Compact overflow trigger (.compact-overflow-trigger)
 * - Overflow menu popover (.mobile-overflow-menu, .mobile-overflow-item)
 *
 * The overflow trigger and menu styles are defined at the top level (shared
 * by mobile and tablet viewports), while the mobile search styles remain
 * inside @media (max-width: 768px) blocks.
 */

describe("mobile-header-controls.css", () => {
  const cssContent = loadAllAppCss();

  // Extract all content from @media (max-width: 768px) blocks
  // This is a simplified approach - we find all mobile media blocks and join them
  function extractMobileMediaBlocks(content: string): string {
    const blocks: string[] = [];
    const regex = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/g;
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      const startIdx = match.index + match[0].length;
      // Find the matching closing brace by counting braces
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

  it("contains at least one @media (max-width: 768px) block", () => {
    expect(mobileCss.length).toBeGreaterThan(0);
  });

  it("has mobile search trigger styles", () => {
    expect(mobileCss).toContain(".mobile-search-trigger");
  });

  it("has mobile search expanded panel styles", () => {
    expect(mobileCss).toContain(".mobile-search-expanded");
  });

  it("has compact overflow trigger styles at top level (shared mobile/tablet)", () => {
    expect(cssContent).toContain(".compact-overflow-trigger");
  });

  it("has overflow menu styles at top level (shared mobile/tablet)", () => {
    expect(cssContent).toContain(".mobile-overflow-menu");
    expect(cssContent).toContain(".mobile-overflow-item");
  });

  it("has overflow menu item hover states", () => {
    expect(cssContent).toMatch(/\.mobile-overflow-item:hover/);
  });

  it("has terminal submenu styles for nested scripts under terminal", () => {
    expect(cssContent).toContain(".mobile-overflow-group");
    expect(cssContent).toContain(".mobile-overflow-submenu");
    expect(cssContent).toContain(".mobile-overflow-subitem");
    expect(cssContent).toContain(".mobile-overflow-chevron");
  });

  it("does not contain obsolete mobile header search wrap rules", () => {
    // The old @media (max-width: 640px) and @media (max-width: 480px) 
    // header search rules should be removed
    const removedPatterns = [
      /@media\s*\(\s*max-width:\s*640px\s*\)\s*\{[^}]*\.header-search/s,
      /@media\s*\(\s*max-width:\s*480px\s*\)\s*\{[^}]*\.header-search/s,
    ];
    
    for (const pattern of removedPatterns) {
      expect(cssContent).not.toMatch(pattern);
    }
  });

  it("has header-wrapper with position relative for positioning context", () => {
    const headerWrapperMatch = cssContent.match(/\.header-wrapper\s*\{([^}]+)\}/);
    expect(headerWrapperMatch).toBeTruthy();
    if (headerWrapperMatch) {
      expect(headerWrapperMatch[1]).toContain("position: relative");
    }
  });

  it("has header-floating-search styles for floating search container", () => {
    const floatingSearchMatch = loadAllAppCssBaseOnly().match(/\.header-floating-search\s*\{([^}]+)\}/);
    expect(floatingSearchMatch).toBeTruthy();
    if (floatingSearchMatch) {
      expect(floatingSearchMatch[1]).toContain("background:");
      expect(floatingSearchMatch[1]).toContain("padding:");
      expect(floatingSearchMatch[1]).toContain("border:");
      expect(floatingSearchMatch[1]).toContain("box-shadow:");
    }
  });

  it("has header-floating-search .header-search with full width", () => {
    const fullWidthMatch = cssContent.match(/\.header-floating-search\s+\.header-search\s*\{([^}]+)\}/);
    expect(fullWidthMatch).toBeTruthy();
    if (fullWidthMatch) {
      expect(fullWidthMatch[1]).toContain("width: 100%");
      expect(fullWidthMatch[1]).toContain("max-width: none");
    }
  });

  it("has mobile-search-expanded with full width in floating container", () => {
    // In the mobile media query, .mobile-search-expanded should have width: 100%
    expect(mobileCss).toContain(".mobile-search-expanded");
    // The selector should have width: 100% rule
    expect(mobileCss).toMatch(/\.mobile-search-expanded\s*\{[^}]*width:\s*100%/);
  });

  it("does not contain fixed-offset patterns that can push mobile search off-screen", () => {
    // Extract all mobile .mobile-search-expanded rules and check they don't have
    // position: absolute with negative left/right offsets
    const expandedBlocks = mobileCss.match(/\.mobile-search-expanded\s*\{[^}]*\}/g) || [];
    for (const block of expandedBlocks) {
      // Fail if any fixed negative offset is found (these push the element off-screen)
      expect(block).not.toMatch(/left:\s*-\d/);
      expect(block).not.toMatch(/right:\s*-\d/);
    }
  });

  it("has mobile header-floating-search with safe-area-inset padding", () => {
    // The header-floating-search in mobile must respect safe-area-inset
    // to prevent clipping on notched devices
    expect(mobileCss).toContain(".header-floating-search");
    // Should have safe-area-inset handling for left/right
    expect(mobileCss).toMatch(/\.header-floating-search\s*\{[^}]*env\(safe-area-inset/);
  });
});
