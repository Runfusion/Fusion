import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
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

describe("nodes-view mobile CSS", () => {
  const cssContent = loadAllAppCss();
  const mobileMediaBlock = extractMobileMediaBlocks(cssContent);

  it("defines .nodes-view-header with compact padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-header");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-header");
    expect(block).toMatch(/padding:\s*var\(--space-sm\)\s+var\(--space-md\)/);
    expect(block).toContain("flex-wrap: wrap");
  });

  it("defines .nodes-view-title h2 with tokenized font size on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-title h2");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-title h2");
    expect(block).toContain("font-size: calc(var(--space-md) + var(--space-xs));");
  });

  it("defines .nodes-view-title h2 svg with flex-shrink: 0 on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-title h2 svg");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-title h2 svg");
    expect(block).toContain("flex-shrink: 0");
  });

  it("defines .nodes-view-count with tokenized smaller font on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-count");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-count");
    expect(block).toContain("font-size: calc(var(--space-sm) + var(--space-xs));");
  });

  it("defines .nodes-view-close with tokenized touch target on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-close");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-close");
    expect(block).toContain("min-height: calc(var(--space-xl) + var(--space-md));");
    expect(block).toContain("min-width: calc(var(--space-xl) + var(--space-md));");
  });

  it("defines .nodes-view-actions with full width on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-actions");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-actions");
    expect(block).toContain("width: 100%");
    expect(block).toContain("flex-wrap: wrap");
    expect(block).toContain("justify-content: flex-end");
  });

  it("defines .nodes-view-actions .btn with tokenized min-height on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-actions .btn");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-actions .btn");
    expect(block).toContain("min-height: calc(var(--space-xl) + var(--space-md));");
  });

  it("defines .nodes-view-stats with 2-column grid on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-stats");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-stats");
    expect(block).toContain("grid-template-columns: repeat(2, 1fr)");
    expect(block).toContain("gap: var(--space-sm)");
  });

  it("defines .nodes-view-stat with compact padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-stat");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-stat");
    expect(block).toContain("padding: var(--space-xs) var(--space-sm)");
  });

  it("defines .nodes-view-stat span with tokenized smaller font on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-stat span");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-stat span");
    expect(block).toContain("font-size: calc(var(--space-sm) + var(--space-xs) * 0.75);");
  });

  it("defines .nodes-view-stat strong with tokenized smaller font on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-stat strong");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-stat strong");
    expect(block).toContain("font-size: calc(var(--space-md) + var(--space-xs) / 2);");
  });

  it("defines .nodes-view-empty with compact padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-empty");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-empty");
    expect(block).toContain("padding: var(--space-xl) var(--space-md)");
    expect(block).toContain("text-align: center");
  });

  it("defines .nodes-view-error with compact padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-error");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-error");
    expect(block).toContain("padding: var(--space-md)");
    expect(block).toContain("margin: var(--space-md) 0");
  });

  it("defines .nodes-view-topology with compact padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-topology");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-topology");
    expect(block).toContain("padding: var(--space-sm) 0");
  });

  it("defines .nodes-view-section-title with tokenized smaller font on mobile", () => {
    expect(mobileMediaBlock).toContain(".nodes-view-section-title");
    const block = extractRuleBlock(mobileMediaBlock, ".nodes-view-section-title");
    expect(block).toContain("font-size: calc(var(--space-md) + var(--space-xs) / 4);");
  });
});
