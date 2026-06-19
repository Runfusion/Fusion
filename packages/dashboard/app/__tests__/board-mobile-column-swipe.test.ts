import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../test/cssFixture";

function extractMediaBlocks(content: string, pattern: RegExp): string {
  const blocks: string[] = [];

  for (const match of content.matchAll(pattern)) {
    const start = match.index! + match[0].length;
    let index = start;
    let depth = 1;
    while (index < content.length && depth > 0) {
      if (content[index] === "{") depth++;
      if (content[index] === "}") depth--;
      index++;
    }
    expect(depth).toBe(0);
    blocks.push(content.slice(start, index - 1));
  }

  expect(blocks.length).toBeGreaterThan(0);
  return blocks.join("\n");
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function ruleBlocks(css: string, selector: string): string[] {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;

  for (const match of stripCssComments(css).matchAll(rulePattern)) {
    const selectorList = match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (selectorList.includes(selector)) {
      blocks.push(`${match[1].trim()} {${match[2]}}`);
    }
  }

  return blocks;
}

function ruleBlock(css: string, selector: string): string {
  const blocks = ruleBlocks(css, selector);
  expect(blocks.length, `missing CSS rule for ${selector}`).toBeGreaterThan(0);
  return blocks[0];
}

function declarationValue(rule: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = rule.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`));
  return match?.[1]?.trim() ?? null;
}

function expectTouchPanXY(css: string, selector: string): void {
  const block = ruleBlock(css, selector);

  expect(declarationValue(block, "touch-action")).toBe("pan-x pan-y");
  expect(block).not.toMatch(/touch-action:\s*pan-y\s*;/);
}

function expectContainmentScroller(block: string): void {
  expect(block).toContain("overflow-x: auto");
  expect(block).toContain("overscroll-behavior-x: contain");
  expect(block).toContain("scroll-snap-type: x proximity");
  expect(block).not.toContain("scroll-snap-type: x mandatory");
}

describe("mobile board column swipe target containment (FN-6389)", () => {
  const css = loadAllAppCss();
  const baseCss = loadAllAppCssBaseOnly();
  const mobileCss = extractMediaBlocks(css, /@media\s*\([^)]*max-width:\s*768px[^)]*\)[^{]*\{/g);

  it("opts classic mobile board column interiors into horizontal panning", () => {
    for (const selector of [".board > .column", ".column", ".column-header", ".column-body"]) {
      expectTouchPanXY(mobileCss, selector);
    }

    const columnBodyBlock = ruleBlock(mobileCss, ".column-body");
    expect(columnBodyBlock).not.toContain("overflow-y: hidden");
  });

  it("opts workflow and multi-lane board interiors into horizontal panning", () => {
    for (const selector of [
      ".board.board-workflow-columns",
      ".board.board-workflow-columns > .column",
      ".lane-columns",
      ".lane-columns > .column",
    ]) {
      expectTouchPanXY(baseCss, selector);
    }
  });

  it("preserves the FN-6365 mobile document pan lock", () => {
    const rootBlock = ruleBlock(mobileCss, "html");
    const appRootBlock = ruleBlock(mobileCss, "#root");
    const starBlocks = ruleBlocks(mobileCss, "*");
    const defaultTouchBlock = starBlocks.find((block) => block.includes("touch-action: pan-y;")) ?? "";
    const widthContainmentBlock = starBlocks.find((block) => block.includes("max-inline-size: 100%;")) ?? "";

    for (const block of [rootBlock, appRootBlock]) {
      expect(block).toContain("overflow-x: hidden;");
      expect(block).toContain("overscroll-behavior-x: none;");
      expect(block).toContain("touch-action: pan-y;");
    }

    expect(rootBlock).toContain("width: 100%;");
    expect(rootBlock).toContain("max-width: 100%;");
    expect(appRootBlock).toContain("min-width: 0;");
    expect(declarationValue(defaultTouchBlock, "touch-action")).toBe("pan-y");
    expect(widthContainmentBlock).toContain("max-width: 100%;");
    expect(widthContainmentBlock).toContain("max-inline-size: 100%;");
  });

  it("preserves FN-6378 horizontal overscroll containment and proximity snap", () => {
    expectContainmentScroller(ruleBlock(baseCss, ".board"));
    expectContainmentScroller(ruleBlock(mobileCss, ".board"));
    expectContainmentScroller(ruleBlock(baseCss, ".board.board-workflow-columns"));
    expectContainmentScroller(ruleBlock(baseCss, ".lane-columns"));
  });
});
