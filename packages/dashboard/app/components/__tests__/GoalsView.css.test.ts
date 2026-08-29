import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";

function goalsBlocks(css: string): string {
  const blocks = css.match(/[^\n]*\.goals-[^{\n]*\{[^}]*\}/gms) ?? [];
  return blocks.join("\n");
}

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

function extractAtRuleBlocks(css: string, atRule: string): string[] {
  const blocks: string[] = [];
  let start = css.indexOf(atRule);

  while (start !== -1) {
    const open = css.indexOf("{", start);
    if (open === -1) break;

    let depth = 1;
    let cursor = open + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === "{") depth++;
      if (css[cursor] === "}") depth--;
      cursor++;
    }

    blocks.push(css.slice(open + 1, cursor - 1));
    start = css.indexOf(atRule, cursor);
  }

  return blocks;
}

function extractRuleBlockFromAtRule(css: string, atRule: string, selector: string): string {
  return extractAtRuleBlocks(css, atRule)
    .map((block) => extractRuleBlock(block, selector))
    .find((block) => block !== "") ?? "";
}

describe("GoalsView CSS token guardrails", () => {
  it("uses tokens and contains mobile/focus rules", async () => {
    const css = await loadAllAppCss();
    const goalsCss = goalsBlocks(css);
    const goalsViewBlock = css.match(/\.goals-view\s*\{[^}]*\}/ms)?.[0] ?? "";

    expect(goalsCss).not.toMatch(/#[0-9a-fA-F]{3,8}/g);
    expect(goalsCss).not.toMatch(/rgba?\(/g);
    expect(goalsCss).not.toMatch(/\b[1-9]\d*px\b/g);
    expect(goalsViewBlock).toContain("height: 100%");
    expect(goalsViewBlock).toContain("overflow-y: auto");
    expect(css).toMatch(/\.goals-[^\n{]*:focus-visible/g);
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.goals-/);
  });

  it("keeps the linked mission picker natural-height in column breakpoints", async () => {
    const css = await loadAllAppCss();
    const basePickerBlock = extractRuleBlock(css, ".goals-linked-missions-picker");
    const mobilePickerBlock = extractRuleBlockFromAtRule(css, "@media (max-width: 768px)", ".goals-linked-missions-picker");
    const tabletPickerBlock = extractRuleBlockFromAtRule(css, "@media (min-width: 769px) and (max-width: 1024px)", ".goals-linked-missions-picker");

    expect(basePickerBlock).toMatch(/flex\s*:\s*1\s+1\s+calc\(var\(--space-xl\)\s*\*\s*10\)/);
    expect(mobilePickerBlock).toMatch(/flex\s*:\s*0\s+0\s+auto/);
    expect(mobilePickerBlock).toMatch(/width\s*:\s*100%/);
    expect(tabletPickerBlock).toMatch(/flex\s*:\s*0\s+0\s+auto/);
    expect(tabletPickerBlock).toMatch(/width\s*:\s*100%/);
  });
});
