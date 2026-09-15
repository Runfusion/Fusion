import { describe, expect, it } from "vitest";
import {
  listComponentFiles,
  loadAllAppCss,
  loadAllAppCssBaseOnly,
  loadComponentCss,
  loadStylesCss,
  readAppFile,
} from "../test/cssFixture";

type CssRule = { selector: string; declarations: string };

/*
FNXC:TabStripTextSelection 2026-09-15-14:23:
FN-423 contract tests for the global tab-strip selection primitive. They guard the invariant that NO tab
strip can begin a text selection — at any pan state, from any host, at any breakpoint — while editable
controls inside a strip keep native selection. The census case additionally prevents a future tab strip
from silently escaping the primitive.
*/

/** Tab-strip classes that carry no `role="tablist"` and are therefore named explicitly in the primitive. */
const ROLELESS_TAB_STRIP_CLASSES = [
  "mailbox-tabs",
  "mailbox-agent-subtabs",
  "terminal-tabs",
  "terminal-mobile-tabs",
  "settings-sidebar",
  "agent-detail-tabs",
  "wf-mobile-tabs",
  "prompt-manager-tabs",
  "project-filter-tabs",
] as const;

/**
 * Deliberate, documented exemptions from the census.
 * - `view-layout__tabs` is ViewLayout's generic slot, which may host a toolbar with prose and fields
 *   rather than a tab strip; the `.detail-tabs` rendered inside it is already covered by its role.
 */
const CENSUS_EXEMPT_CLASSES = new Set<string>(["view-layout__tabs"]);

/** CSS comments sit between rules, so they leak into a naive selector capture; drop them first. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

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
  const mediaStart = /@media[^{]+\{/g;

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

/** Every `className` literal token that names a tab strip (any token ending in `tabs`, which covers `subtabs`). */
function tabStripClassOccurrences(source: string): { className: string; index: number }[] {
  const occurrences: { className: string; index: number }[] = [];

  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    const raw = match[1] ?? match[2] ?? "";
    for (const token of raw.split(/[^A-Za-z0-9_-]+/)) {
      if (/^[A-Za-z0-9_-]+tabs$/.test(token)) {
        occurrences.push({ className: token, index: match.index! });
      }
    }
  }

  return occurrences;
}

function declaresTablistRoleNear(source: string, index: number): boolean {
  return source.slice(Math.max(0, index - 200), index + 400).includes('role="tablist"');
}

describe("tab-strip text-selection CSS contract (FN-423)", () => {
  it("suppresses selection on every tab strip and its descendants, unconditionally", () => {
    const baseCss = stripComments(loadAllAppCssBaseOnly());
    const suppressionRule = expectRuleToContain(baseCss, '[role="tablist"]', "user-select: none;");

    expect(suppressionRule.declarations).toContain("-webkit-user-select: none;");
    expect(suppressionRule.declarations).toContain("-webkit-touch-callout: none;");
    // Descendants are covered, so a tab LABEL cannot be selected either.
    expect(suppressionRule.selector).toMatch(/\)\s*\*/);
    // The suppression is not gated on any pan state.
    expect(suppressionRule.selector).not.toContain("is-mouse-panning");

    for (const className of ROLELESS_TAB_STRIP_CLASSES) {
      expect(suppressionRule.selector).toContain(`.${className}`);
    }
  });

  it("keeps a more-specific editable carve-out declared after the suppression", () => {
    const stylesCss = stripComments(loadStylesCss());
    const optInRule = expectRuleToContain(stylesCss, '[role="tablist"]', "user-select: text;");

    expect(optInRule.declarations).toContain("-webkit-user-select: text;");
    expect(optInRule.declarations).toContain("-webkit-touch-callout: default;");
    expect(optInRule.selector).toContain("input");
    expect(optInRule.selector).toContain("textarea");
    expect(optInRule.selector).toContain("select");
    expect(optInRule.selector).toContain('[contenteditable="true"]');

    const suppressionRule = expectRuleToContain(stylesCss, '[role="tablist"]', "user-select: none;");
    expect(stylesCss.indexOf(suppressionRule.selector)).toBeLessThan(stylesCss.indexOf(optInRule.selector));
  });

  it("does not re-enable non-editable tab-strip selection inside responsive media blocks", () => {
    const fragments = ['[role="tablist"]', ...ROLELESS_TAB_STRIP_CLASSES.map((name) => `.${name}`)];
    const responsiveRules = mediaBlocks(stripComments(loadAllAppCss())).flatMap((block) =>
      fragments.flatMap((fragment) => findRules(block, fragment)),
    );

    for (const { declarations } of responsiveRules) {
      expect(declarations).not.toMatch(/(?:-webkit-)?user-select:\s*(?:text|auto)\s*;/);
    }
  });

  it("covers every tab strip rendered by a dashboard component", () => {
    const suppressionSelector = expectRuleToContain(
      stripComments(loadStylesCss()),
      '[role="tablist"]',
      "user-select: none;",
    ).selector;
    const uncovered: string[] = [];

    for (const file of listComponentFiles()) {
      const source = readAppFile(`components/${file}`);
      for (const { className, index } of tabStripClassOccurrences(source)) {
        if (CENSUS_EXEMPT_CLASSES.has(className)) continue;
        if (suppressionSelector.includes(`.${className}`)) continue;
        if (declaresTablistRoleNear(source, index)) continue;
        uncovered.push(`${file}: .${className}`);
      }
    }

    expect(uncovered).toEqual([]);
  });

  it("leaves the Task Detail panning state owning the cursor only", () => {
    const stripCss = loadComponentCss("TaskDetailTabStrip.css");

    expect(stripCss).not.toMatch(/user-select\s*:/);
    expect(stripCss).toMatch(/\.detail-tabs\.is-mouse-panning[\s\S]*?cursor\s*:\s*grabbing\s*!important\s*;/);
  });
});
