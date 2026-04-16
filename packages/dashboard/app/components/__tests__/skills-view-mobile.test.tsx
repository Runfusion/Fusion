import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

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

describe("skills-view mobile css", () => {
  const cssPath = resolve(__dirname, "../../styles.css");
  const cssContent = readFileSync(cssPath, "utf-8");
  const mobileMediaBlock = extractMobileMediaBlocks(cssContent);

  it("defines .skills-view-header in mobile block with reduced padding", () => {
    expect(mobileMediaBlock).toContain(".skills-view-header");
    const block = extractRuleBlock(cssContent, ".skills-view-header");
    // Base has padding: var(--space-lg) 20px; mobile should override
    expect(block).toMatch(/padding:\s*var\(--space-sm\)\s+var\(--space-md\)/);
  });

  it("defines .skills-view-title h2 with smaller font on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-title h2");
    const block = extractRuleBlock(cssContent, ".skills-view-title h2");
    expect(block).toContain("font-size: 16px");
  });

  it("defines .skills-view-content with reduced padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-content");
    const block = extractRuleBlock(cssContent, ".skills-view-content");
    expect(block).toContain("padding: var(--space-md)");
  });

  it("defines .skills-view-search .form-input as full width on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-search .form-input");
    const block = extractRuleBlock(cssContent, ".skills-view-search .form-input");
    expect(block).toContain("max-width: none");
    expect(block).toContain("width: 100%");
  });

  it("collapses catalog grid to single column on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-grid");
    expect(mobileMediaBlock).toMatch(/\.skills-view-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
  });

  it("defines .skills-view-item wrapping on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-item");
    const block = extractRuleBlock(cssContent, ".skills-view-item");
    expect(block).toContain("flex-wrap: wrap");
  });

  it("defines .skills-view-toggle-slider with minimum dimensions on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-toggle-slider");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-toggle-slider");
    expect(block).toContain("min-width: 40px");
    expect(block).toContain("min-height: 22px");
  });

  it("defines .skills-view-section with reduced margin-bottom on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-section");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-section");
    expect(block).toMatch(/margin-bottom:\s*var\(--space-md\)/);
  });

  it("defines .skills-view-section-title with smaller font on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-section-title");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-section-title");
    expect(block).toContain("font-size: 13px");
  });

  it("defines .skills-view-card with reduced padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-card");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-card");
    expect(block).toContain("padding: var(--space-sm)");
  });

  it("defines .skills-view-card-title with smaller font on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-card-title");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-card-title");
    expect(block).toContain("font-size: 13px");
  });

  it("defines .skills-view-card-description with smaller font on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-card-description");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-card-description");
    expect(block).toContain("font-size: 12px");
  });

  it("defines .skills-view-empty with reduced padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-empty");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-empty");
    expect(block).toContain("padding: var(--space-lg)");
  });

  it("defines .skills-view-error with reduced padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-error");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-error");
    expect(block).toContain("padding: var(--space-lg)");
  });

  it("defines .skills-view-loading with reduced padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-loading");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-loading");
    expect(block).toContain("padding: var(--space-md)");
  });

  it("defines .skills-view-item with padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-item");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-item");
    expect(block).toContain("padding: var(--space-md)");
  });

  it("defines .skills-view-item-info with full width on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-item-info");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-item-info");
    expect(block).toContain("width: 100%");
  });

  it("defines .skills-view-item-toggle with padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-item-toggle");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-item-toggle");
    expect(block).toContain("padding: var(--space-sm)");
  });

  it("defines .skills-view-count with smaller font on mobile", () => {
    expect(mobileMediaBlock).toContain(".skills-view-count");
    const block = extractRuleBlock(mobileMediaBlock, ".skills-view-count");
    expect(block).toContain("font-size: 12px");
  });

  it("defines .badge--sm base class in CSS", () => {
    expect(cssContent).toContain(".badge--sm {");
    const block = extractRuleBlock(cssContent, ".badge--sm");
    expect(block).toContain("font-size: 10px");
    expect(block).toContain("padding: 1px 6px");
  });

  it("skills-view base styles are defined in styles.css", () => {
    expect(cssContent).toContain(".skills-view {");
    expect(cssContent).toContain(".skills-view-header {");
    expect(cssContent).toContain(".skills-view-title {");
    expect(cssContent).toContain(".skills-view-content {");
    expect(cssContent).toContain(".skills-view-section {");
    expect(cssContent).toContain(".skills-view-list {");
    expect(cssContent).toContain(".skills-view-item {");
    expect(cssContent).toContain(".skills-view-card {");
    expect(cssContent).toContain(".skills-view-grid {");
    expect(cssContent).toContain(".skills-view-search {");
    expect(cssContent).toContain(".skills-view-toggle-slider {");
  });
});
