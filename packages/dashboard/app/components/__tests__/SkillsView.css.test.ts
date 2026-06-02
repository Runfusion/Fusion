import { describe, expect, it } from "vitest";

import { loadAllAppCss } from "../../test/cssFixture";

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g"))];
  return matches.at(-1)?.[1] ?? "";
}

function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media[^{]*\(max-width: 768px\)[^{]*\{/g;
  let match: RegExpExecArray | null;

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

describe("SkillsView/runtime-card token guardrails", () => {
  it("does not use forbidden runtime fallback literals/tokens", async () => {
    const css = await loadAllAppCss();

    expect(css).not.toContain("var(--accent-green");
    expect(css).not.toContain("var(--accent-red");
    expect(css).not.toContain("var(--space-xxs");
    expect(css).not.toContain("var(--accent-green, #22c55e)");
    expect(css).not.toContain("var(--accent-red, #ef4444)");
    expect(css).not.toContain("var(--accent, #4f46e5)");
  });

  it("keeps discovered-skill rows on one line at the mobile breakpoint", async () => {
    const css = await loadAllAppCss();
    const mobileMediaBlock = extractMobileMediaBlocks(css);
    const itemBlock = extractRuleBlock(mobileMediaBlock, ".skills-view-item");
    const infoBlock = extractRuleBlock(mobileMediaBlock, ".skills-view-item-info");

    expect(itemBlock).toContain("flex-wrap: nowrap");
    expect(infoBlock).toContain("flex: 1 1 auto");
    expect(infoBlock).toContain("width: auto");
  });

  it("keeps checked and unchecked toggle geometry token-aligned", async () => {
    const css = await loadAllAppCss();

    expect(css).toContain("width: calc(var(--space-xl) + var(--space-lg))");
    expect(css).toContain("transform: translateX(calc(var(--space-lg) + (var(--space-xs) / 2)))");
    expect(css).toContain("background: var(--color-success)");
  });
});
