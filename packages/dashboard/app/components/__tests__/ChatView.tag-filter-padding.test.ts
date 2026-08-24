import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
FNXC:ChatTags 2026-08-23-15:51:
The shared Direct-scope tag filter must preserve the sidebar search input's comfortable token-based padding in every ChatView host. jsdom does not compute cascaded external stylesheet padding, so this stylesheet-source assertion is the enforceable regression seam for the cramped "All tags" control.
*/
const chatViewCss = readFileSync(resolve(__dirname, "../ChatView.css"), "utf8");

function uncomment(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function collectTagFilterBlocks(css: string): Array<{ selector: string; block: string }> {
  const blocks: Array<{ selector: string; block: string }> = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;

  for (const match of uncomment(css).matchAll(rulePattern)) {
    const selector = match[1].trim();
    if (selector.split(",").some((part) => part.trim().includes(".chat-tag-filter select"))) {
      blocks.push({ selector, block: match[2] });
    }
  }

  return blocks;
}

function paddingDeclaration(block: string): string | undefined {
  return block.match(/(?:^|;)\s*padding\s*:\s*([^;]+)/)?.[1]?.trim();
}

describe("ChatView tag filter padding", () => {
  it("keeps the All tags select aligned with the sidebar search input across stylesheet rules", () => {
    const blocks = collectTagFilterBlocks(chatViewCss);
    expect(blocks.length).toBeGreaterThanOrEqual(1);

    const base = blocks.find(({ selector }) => selector === ".chat-tag-filter select");
    expect(base, "base .chat-tag-filter select rule must exist").toBeDefined();

    const basePadding = paddingDeclaration(base!.block);
    expect(basePadding).toContain("var(--space-sm)");
    expect(basePadding).toContain("var(--space-md)");

    for (const { selector, block } of blocks) {
      const padding = paddingDeclaration(block);
      if (!padding) continue;

      expect(padding, `tag filter rule "${selector}" must not restore cramped padding`).not.toMatch(
        /^var\(--space-xs\)$/,
      );
      expect(padding, `tag filter rule "${selector}" must use design tokens, not raw dimensions or colors`).not.toMatch(
        /(?:\d(?:\.\d+)?(?:px|rem)|#[0-9a-f]{3,8})/i,
      );
      expect(padding, `tag filter rule "${selector}" must use only --space-* tokens`).toMatch(
        /^var\(--space-[a-z0-9-]+\)(?:\s+var\(--space-[a-z0-9-]+\)){0,3}$/,
      );
    }
  });
});
