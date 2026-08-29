import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
FNXC:ChatView 2026-07-23-18:15:
Regression guard for the Latest jump chip teleporting under the cursor. The control is shared by
main Chat, floating Quick Chat, and room threads (`.chat-jump-to-latest`). Centering must not use
`transform: translateX(-50%)` because global `.btn:active { transform: scale(0.97) }` and
`.btn { transition: transform }` replace or animate that translate and shift the chip sideways when
the pointer approaches or presses it. jsdom cannot hit-test the mid-press jump, so the invariant is
asserted on the stylesheet: every transform rule that targets the jump class is forbidden, and the
base rule must center with left/right + margin-inline auto + width: fit-content.
*/
const chatViewCss = readFileSync(resolve(__dirname, "../ChatView.css"), "utf8");

function uncomment(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function collectJumpBlocks(css: string): Array<{ selector: string; block: string }> {
  const blocks: Array<{ selector: string; block: string }> = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of uncomment(css).matchAll(rulePattern)) {
    const selector = match[1].trim();
    if (selector.split(",").some((part) => part.trim().includes(".chat-jump-to-latest"))) {
      blocks.push({ selector, block: match[2] });
    }
  }
  return blocks;
}

describe("ChatView jump-to-latest centering", () => {
  it("centers without transform so btn press/hover transitions cannot shift the chip sideways", () => {
    const blocks = collectJumpBlocks(chatViewCss);
    expect(blocks.length).toBeGreaterThanOrEqual(1);

    const base = blocks.find(({ selector }) => selector.trim() === ".chat-jump-to-latest");
    expect(base, "base .chat-jump-to-latest rule must exist").toBeDefined();
    expect(base!.block).toMatch(/left\s*:\s*0/);
    expect(base!.block).toMatch(/right\s*:\s*0/);
    expect(base!.block).toMatch(/margin-inline\s*:\s*auto/);
    expect(base!.block).toMatch(/width\s*:\s*fit-content/);
    expect(base!.block).not.toMatch(/transform\s*:/);
    expect(base!.block).not.toMatch(/translateX\s*\(/);

    for (const { selector, block } of blocks) {
      expect(
        block,
        `jump rule "${selector}" must not own transform (global .btn:active/hover transitions own it)`,
      ).not.toMatch(/transform\s*:/);
    }
  });
});
