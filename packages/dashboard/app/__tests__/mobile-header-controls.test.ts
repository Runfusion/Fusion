import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

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
  const cssPath = resolve(__dirname, "../styles.css");
  const cssContent = readFileSync(cssPath, "utf-8");

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

  it("has position relative on header-actions for absolute positioning", () => {
    // Find the .header-actions rule and check for position: relative
    const headerActionsMatch = cssContent.match(/\.header-actions\s*\{([^}]+)\}/);
    expect(headerActionsMatch).toBeTruthy();
    if (headerActionsMatch) {
      expect(headerActionsMatch[1]).toContain("position: relative");
    }
  });
});
