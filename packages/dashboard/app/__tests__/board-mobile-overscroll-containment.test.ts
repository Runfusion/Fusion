import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../test/cssFixture";

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

function extractRuleBlock(content: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`))?.[0] ?? "";
}

describe("board-mobile-overscroll-containment (FN-6378)", () => {
  const cssContent = loadAllAppCss();
  const baseCss = loadAllAppCssBaseOnly();
  const mobileCss = extractMobileMediaBlocks(cssContent);

  it("mobile .board contains horizontal overscroll while preserving intentional scroll and proximity snap", () => {
    const boardBlock = extractRuleBlock(mobileCss, ".board");

    expect(boardBlock).toContain("overflow-x: auto");
    expect(boardBlock).toContain("overscroll-behavior-x: contain");
    expect(boardBlock).toContain("scroll-snap-type: x proximity");
    expect(boardBlock).not.toContain("scroll-snap-type: x mandatory");
  });

  /*
  FNXC:BoardNavigation 2026-07-24-10:05:
  Desktop must never snap: the base scrollers keep overscroll containment but declare
  `scroll-snap-type: none`, so wheel/trackpad panning is free of the browser's snap settle
  animation. Snapping is asserted only inside the phone-tier media blocks above/below.
  */
  it("base .board contains horizontal overscroll and does not snap on desktop", () => {
    const boardBlock = extractRuleBlock(baseCss, ".board");

    expect(boardBlock).toContain("overflow-x: auto");
    expect(boardBlock).toContain("overscroll-behavior-x: contain");
    expect(boardBlock).toContain("scroll-snap-type: none");
    expect(boardBlock).not.toContain("scroll-snap-type: x");
  });

  it("live workflow Board columns contain horizontal overscroll and do not snap on desktop", () => {
    const workflowColumnsBlock = extractRuleBlock(baseCss, ".board.board-workflow-columns");

    expect(workflowColumnsBlock).toContain("overflow-x: auto");
    expect(workflowColumnsBlock).toContain("overscroll-behavior-x: contain");
    expect(workflowColumnsBlock).toContain("scroll-snap-type: none");
    expect(workflowColumnsBlock).not.toContain("scroll-snap-type: x");
  });

  it("does not ship the retired lane selector in base or phone CSS", () => {
    expect(baseCss).not.toMatch(/\.lane-columns\b/);
    expect(mobileCss).not.toMatch(/\.lane-columns\b/);
  });

  it("phone tier re-enables proximity snapping for the live workflow Board", () => {
    const workflowColumnsBlock = extractRuleBlock(mobileCss, ".board.board-workflow-columns");

    expect(workflowColumnsBlock).toContain("scroll-snap-type: x proximity");
    expect(workflowColumnsBlock).not.toContain("scroll-snap-type: x mandatory");
  });
});
