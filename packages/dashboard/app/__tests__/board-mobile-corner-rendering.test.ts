import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

/**
 * Stylesheet regression test for FN-001: Mobile board "corner rendering" bug.
 *
 * When switching from ListView to Board view on iOS Safari, the board could
 * render compressed in a corner of the viewport. The root cause was
 * `scroll-snap-type: x mandatory` forcing an immediate snap using stale layout
 * measurements before flex children had resolved their intrinsic widths.
 *
 * This test locks in the stabilization properties that prevent the bug.
 */

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

describe("board-mobile-corner-rendering (FN-001)", () => {
  const cssContent = loadAllAppCss();
  const mobileCss = extractMobileMediaBlocks(cssContent);

  it("mobile .board uses scroll-snap-type: x proximity (not mandatory)", () => {
    const boardBlock = mobileCss.match(/\.board\s*\{[^}]*\}/)?.[0] ?? "";
    expect(boardBlock).toContain("scroll-snap-type: x proximity");
    expect(boardBlock).not.toContain("scroll-snap-type: x mandatory");
  });

  it("mobile .board declares overflow-anchor: none", () => {
    const boardBlock = mobileCss.match(/\.board\s*\{[^}]*\}/)?.[0] ?? "";
    expect(boardBlock).toContain("overflow-anchor: none");
  });

  it("mobile .board declares width: 100%", () => {
    const boardBlock = mobileCss.match(/\.board\s*\{[^}]*\}/)?.[0] ?? "";
    expect(boardBlock).toContain("width: 100%");
  });

  it("mobile .list-view declares width: 100%", () => {
    // .list-view width is defined in the base rule, not inside a media query,
    // so we check the full CSS bundle.
    const listBlock = cssContent.match(/\.list-view\s*\{[^}]*\}/)?.[0] ?? "";
    expect(listBlock).toContain("width: 100%");
  });

  it("mobile .board does not use scroll-snap-type: x mandatory anywhere", () => {
    // Mandatory snap should not appear in any mobile media block.
    expect(mobileCss).not.toContain("scroll-snap-type: x mandatory");
  });
});
