import { describe, expect, it } from "vitest";
import {
  listComponentFiles,
  loadAllAppCss,
  loadAllAppCssBaseOnly,
  loadStylesCss,
  readAppFile,
} from "../test/cssFixture";

type CssRule = { selector: string; declarations: string };

/*
FNXC:LongPressTextSelection 2026-09-18-01:13:
FN-521 contract tests. They guard the invariant that a long press meant to OPEN A CONTEXT MENU never starts a
native text selection or an iOS callout — on any long-press surface, from any host, at any breakpoint — while
editable controls nested in a row keep native selection. The census case prevents a future host of
`useListItemContextMenu` from silently escaping the primitive.
*/

/** Selectors carrying the long-press-opens-a-menu contract, named by the global primitive. */
const LONG_PRESS_SELECTORS = ["[data-drawer-dismiss-row]", ".list-card", ".file-node"] as const;

/**
 * Deliberate, documented exemptions from the host census. Empty by default: every component that consumes
 * `useListItemContextMenu` must qualify its row through `getRowProps(...)`, which is what applies
 * `data-drawer-dismiss-row` and therefore the suppression above.
 */
const CENSUS_EXEMPT_COMPONENTS = new Set<string>([]);

/** CSS comments sit between rules, so they leak into a naive selector capture; drop them first. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function findRules(css: string, selectorFragment: string): CssRule[] {
  const rules: CssRule[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([\s\S]*?)\}/g)) {
    const [, selector, declarations] = match;
    if (selector.includes(selectorFragment)) rules.push({ selector, declarations });
  }
  return rules;
}

function expectRuleToContain(css: string, selectorFragment: string, declaration: string): CssRule {
  const rules = findRules(css, selectorFragment);
  expect(rules).not.toHaveLength(0);
  const rule = rules.find(({ declarations }) => declarations.includes(declaration));
  expect(rule, `expected a rule on ${selectorFragment} declaring ${declaration}`).toBeDefined();
  return rule!;
}

function mediaBlocks(css: string): string[] {
  const blocks: string[] = [];
  for (const match of css.matchAll(/@media[^{]+\{/g)) {
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

describe("long-press surfaces never start a text selection (FN-521)", () => {
  // (a)
  it("suppresses selection and the touch callout on every long-press surface and its descendants", () => {
    const baseCss = stripComments(loadAllAppCssBaseOnly());
    const suppression = expectRuleToContain(baseCss, "[data-drawer-dismiss-row]", "user-select: none;");

    expect(suppression.declarations).toContain("-webkit-user-select: none;");
    expect(suppression.declarations).toContain("-webkit-touch-callout: none;");
    // Descendants are covered, so the row LABEL under the finger cannot be selected either.
    expect(suppression.selector).toMatch(/\)\s*\*/);

    for (const selector of LONG_PRESS_SELECTORS) {
      expect(suppression.selector).toContain(selector);
    }
  });

  // (b)
  it("does not regress the pre-existing board-card suppression", () => {
    const cardCss = stripComments(readAppFile("components/TaskCard.css"));
    const suppression = expectRuleToContain(cardCss, ".card:not(.card-editing)", "user-select: none;");

    expect(suppression.declarations).toContain("-webkit-user-select: none;");
    expect(suppression.declarations).toContain("-webkit-touch-callout: none;");
    expect(suppression.selector).toMatch(/\.card:not\(\.card-editing\)\s*\*/);
  });

  // (c)
  it("declares suppression and the editable carve-out as base rules, in that source order", () => {
    const stylesCss = stripComments(loadStylesCss());
    const suppression = expectRuleToContain(stylesCss, "[data-drawer-dismiss-row]", "user-select: none;");
    const carveOut = expectRuleToContain(stylesCss, "[data-drawer-dismiss-row]", "user-select: text;");

    expect(carveOut.declarations).toContain("-webkit-user-select: text;");
    expect(carveOut.declarations).toContain("-webkit-touch-callout: default;");
    for (const control of ["input", "textarea", "select", '[contenteditable="true"]']) {
      expect(carveOut.selector).toContain(control);
    }

    expect(stylesCss.indexOf(suppression.selector)).toBeLessThan(stylesCss.indexOf(carveOut.selector));

    // Both rules survive the @media strip, so they hold at every breakpoint.
    const baseCss = stripComments(loadAllAppCssBaseOnly());
    expect(findRules(baseCss, "[data-drawer-dismiss-row]").some((r) => r.declarations.includes("user-select: none;"))).toBe(true);
    expect(findRules(baseCss, "[data-drawer-dismiss-row]").some((r) => r.declarations.includes("user-select: text;"))).toBe(true);
  });

  // (d)
  it("never re-enables non-editable selection on these surfaces inside a media block", () => {
    const responsiveRules = mediaBlocks(stripComments(loadAllAppCss())).flatMap((block) =>
      LONG_PRESS_SELECTORS.flatMap((selector) => findRules(block, selector)),
    );

    for (const { selector, declarations } of responsiveRules) {
      if (selector.includes("input") || selector.includes("textarea") || selector.includes("contenteditable")) continue;
      expect(declarations, `media override on ${selector}`).not.toMatch(/(?:-webkit-)?user-select:\s*(?:text|auto)\s*;/);
    }
  });

  // (e)
  it("covers every component that opens a row context menu", () => {
    const uncovered: string[] = [];

    for (const file of listComponentFiles()) {
      if (CENSUS_EXEMPT_COMPONENTS.has(file)) continue;
      const source = readAppFile(`components/${file}`);
      if (!source.includes("useListItemContextMenu")) continue;
      // The shared renderer itself hosts no row; only consumers must qualify their rows.
      if (file === "ListItemContextMenu.tsx") continue;
      if (!source.includes("getRowProps(")) uncovered.push(file);
    }

    expect(uncovered).toEqual([]);
  });
});
