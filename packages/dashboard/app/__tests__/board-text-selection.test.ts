import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly, loadComponentCss } from "../test/cssFixture";

type CssRule = { selector: string; declarations: string };

function findRules(css: string, selectorFragment: string): CssRule[] {
  const rules: CssRule[] = [];
  const pattern = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of css.matchAll(pattern)) {
    const [, selector, declarations] = match;
    if (selector.includes(selectorFragment)) {
      rules.push({ selector, declarations });
    }
  }

  return rules;
}

function expectRuleToContain(css: string, selectorFragment: string, declaration: string): CssRule {
  const rules = findRules(css, selectorFragment);

  expect(rules).not.toHaveLength(0);
  const rule = rules.find(({ declarations }) => declarations.includes(declaration));
  expect(rule).toBeDefined();
  return rule!;
}

function mediaBlocks(css: string): string[] {
  const blocks: string[] = [];
  const mediaStart = /@media[^\{]+\{/g;

  for (const match of css.matchAll(mediaStart)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let end = start;

    while (end < css.length && depth > 0) {
      if (css[end] === "{") depth++;
      if (css[end] === "}") depth--;
      end++;
    }

    blocks.push(css.slice(start, end - 1));
  }

  return blocks;
}

describe("board text-selection CSS contract (FN-194)", () => {
  it("suppresses selection from every base board descendant while retaining editable opt-ins", () => {
    const baseCss = loadAllAppCssBaseOnly();
    const suppressionRule = expectRuleToContain(baseCss, ".board *", "user-select: none;");

    expect(suppressionRule.declarations).toContain("-webkit-user-select: none;");

    const optInRule = expectRuleToContain(baseCss, ".board :is(", "user-select: text;");
    expect(optInRule.declarations).toContain("-webkit-user-select: text;");
    expect(optInRule.selector).toContain("input");
    expect(optInRule.selector).toContain("textarea");
    expect(optInRule.selector).toContain("select");
    expect(optInRule.selector).toContain('[contenteditable="true"]');
    expect(optInRule.selector).toContain(".card-editing");
  });

  it("does not re-enable non-editable board selection inside responsive media blocks", () => {
    const responsiveBoardRules = mediaBlocks(loadAllAppCss()).flatMap((block) => findRules(block, ".board"));

    expect(responsiveBoardRules).not.toHaveLength(0);
    for (const { declarations } of responsiveBoardRules) {
      expect(declarations).not.toMatch(/(?:-webkit-)?user-select:\s*(?:text|auto)\s*;/);
    }
  });

  it("keeps one broadly anchored suppression rule before its more-specific editable opt-in", () => {
    const boardCss = loadComponentCss("Board.css");
    const suppressionRules = findRules(boardCss, ".board *");
    const optInRules = findRules(boardCss, ".board :is(");

    expect(suppressionRules).toHaveLength(1);
    expect(optInRules).toHaveLength(1);
    expect(suppressionRules[0]!.selector).not.toContain("board-workflow-columns");
    expect(suppressionRules[0]!.selector).not.toContain("board-workflows-skeleton");
    expect(boardCss.indexOf(suppressionRules[0]!.selector)).toBeLessThan(boardCss.indexOf(optInRules[0]!.selector));
  });
});
