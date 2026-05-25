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

describe("board tablet overflow regression (FN-5281)", () => {
  const css = loadAllAppCss();
  const baseCss = loadAllAppCssBaseOnly();
  const tabletCss = extractMediaBlocks(css, /@media\s*\(\s*min-width:\s*769px\s*\)\s*and\s*\(\s*max-width:\s*1024px\s*\)\s*\{/g);
  const mobileCss = extractMediaBlocks(css, /@media\s*\([^)]*max-width:\s*768px[^)]*\)[^{]*\{/g);

  it("defines a tablet .board rule that fits all columns without horizontal board panning", () => {
    const boardBlock = tabletCss.match(/\.board\s*\{[^}]*\}/)?.[0] ?? "";

    expect(boardBlock).toContain("grid-template-columns: repeat(6, minmax(260px, 1fr));");
    expect(boardBlock).toContain("overflow-x: auto;");
    expect(boardBlock).not.toContain("scroll-snap-type:");
  });

  it("preserves the mobile board snap invariants", () => {
    const boardBlock = mobileCss.match(/\.board\s*\{[^}]*\}/)?.[0] ?? "";

    expect(boardBlock).toContain("scroll-snap-type: x proximity");
    expect(boardBlock).toContain("overflow-anchor: none");
  });

  it("leaves the desktop base .board rule unchanged", () => {
    const boardBlock = baseCss.match(/\.board\s*\{[^}]*\}/)?.[0] ?? "";

    expect(boardBlock).toContain("grid-template-columns: repeat(6, minmax(300px, 1fr));");
    expect(boardBlock).toContain("overflow-x: auto;");
  });
});
