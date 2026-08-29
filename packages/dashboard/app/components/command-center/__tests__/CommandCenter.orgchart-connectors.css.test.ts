/*
FNXC:CommandCenter 2026-06-21-00:00:
FN-6884 guards the Team-tab org chart as raw CSS because jsdom cannot prove connector pseudo-elements or scroll viewport height. The invariant is that both layout modes retain parent-to-child connector lines and the desktop/mobile viewport heights stay above the previously cramped values.
*/
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = resolve(__dirname, "..", "..", "..");
const STYLES_CSS = join(APP_DIR, "styles.css");
const AREAS_CSS = join(APP_DIR, "components", "command-center", "areas", "areas.css");

function extractRuleBlocks(css: string, selector: string): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;
  while (searchFrom < css.length) {
    const ruleStart = css.indexOf(`${selector} {`, searchFrom);
    if (ruleStart === -1) break;
    const bodyStart = css.indexOf("{", ruleStart);
    const bodyEnd = css.indexOf("\n}", bodyStart);
    expect(bodyEnd, `Expected ${selector} rule to have a closing brace`).toBeGreaterThan(bodyStart);
    blocks.push(css.slice(bodyStart + 1, bodyEnd));
    searchFrom = bodyEnd + 2;
  }
  expect(blocks.length, `Expected ${selector} to exist in areas.css`).toBeGreaterThan(0);
  return blocks;
}

function extractRuleBlock(css: string, selector: string): string {
  return extractRuleBlocks(css, selector)[0];
}

function extractRuleBlockContaining(css: string, selector: string, declarationPattern: RegExp): string {
  const blocks = extractRuleBlocks(css, selector);
  const block = blocks.find((candidate) => declarationPattern.test(candidate));
  expect(block, `Expected ${selector} to contain ${declarationPattern.source}`).toBeDefined();
  return block ?? "";
}

function collectDefinedProperties(css: string): Set<string> {
  const defined = new Set<string>();
  const re = /(--[a-z0-9-]+)\s*:/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    defined.add(match[1]);
  }
  return defined;
}

function collectReferencedProperties(css: string): Set<string> {
  const referenced = new Set<string>();
  const re = /var\(\s*(--[a-z0-9-]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    referenced.add(match[1]);
  }
  return referenced;
}

describe("Command Center Team org chart CSS connectors (FN-6884)", () => {
  const css = readFileSync(AREAS_CSS, "utf8");

  it("keeps the org-chart scroll viewport taller on desktop and mobile", () => {
    const baseScrollBlock = extractRuleBlock(css, ".cc-team-org-scroll");
    expect(baseScrollBlock).toMatch(/max-block-size\s*:\s*calc\(var\(--space-2xl\) \* 13\)\s*;/);
    expect(baseScrollBlock).toMatch(/overflow\s*:\s*auto\s*;/);
    expect(baseScrollBlock).toMatch(/overscroll-behavior\s*:\s*contain\s*;/);
    expect(baseScrollBlock).not.toMatch(/calc\(var\(--space-2xl\) \* 10\)/);

    expect(css).toMatch(
      /@media \(max-width: 768px\) \{[\s\S]*?\.cc-team-org-scroll\s*\{[\s\S]*?max-block-size\s*:\s*calc\(var\(--space-2xl\) \* 10\)\s*;/,
    );
    expect(css).not.toMatch(
      /@media \(max-width: 768px\) \{[\s\S]*?\.cc-team-org-scroll\s*\{[\s\S]*?max-block-size\s*:\s*calc\(var\(--space-2xl\) \* 8\)\s*;/,
    );
  });

  it("draws parent-to-child connector lines in vertical and horizontal layout scopes", () => {
    const verticalChildrenBlock = extractRuleBlockContaining(
      css,
      '.cc-team-org-scroll[data-layout="vertical"] .cc-team-org-children',
      /border-inline-start\s*:\s*thin solid var\(--border-subtle\)\s*;/,
    );
    expect(verticalChildrenBlock).toMatch(/border-inline-start\s*:\s*thin solid var\(--border-subtle\)\s*;/);

    const horizontalChildrenBlock = extractRuleBlockContaining(
      css,
      '.cc-team-org-scroll[data-layout="horizontal"] .cc-team-org-children',
      /position\s*:\s*relative\s*;/,
    );
    expect(horizontalChildrenBlock).toMatch(/position\s*:\s*relative\s*;/);
    expect(horizontalChildrenBlock).toMatch(/padding-block-start\s*:\s*var\(--space-md\)\s*;/);

    const horizontalParentDrop = extractRuleBlock(css, '.cc-team-org-scroll[data-layout="horizontal"] .cc-team-org-children::before');
    expect(horizontalParentDrop).toMatch(/border-inline-start\s*:\s*thin solid var\(--border-subtle\)\s*;/);

    const horizontalSiblingRail = extractRuleBlock(css, '.cc-team-org-scroll[data-layout="horizontal"] .cc-team-org-children::after');
    expect(horizontalSiblingRail).toMatch(/border-block-start\s*:\s*thin solid var\(--border-subtle\)\s*;/);

    const horizontalChildDrops = extractRuleBlockContaining(
      css,
      '.cc-team-org-scroll[data-layout="horizontal"] .cc-team-org-children > .cc-team-org-item::before',
      /border-inline-start\s*:\s*thin solid var\(--border-subtle\)\s*;/,
    );
    expect(horizontalChildDrops).toMatch(/border-inline-start\s*:\s*thin solid var\(--border-subtle\)\s*;/);
    expect(css).not.toContain('.cc-team-org-scroll[data-layout="horizontal"] .cc-team-org-item::before {');
  });

  it("uses only defined design tokens in the org-chart rules", () => {
    const stylesCss = readFileSync(STYLES_CSS, "utf8");
    const definedProperties = collectDefinedProperties(stylesCss);
    const orgChartCss = css
      .split("\n")
      .filter((line) => line.includes("cc-team-org") || line.includes("var(--"))
      .join("\n");
    const missing = [...collectReferencedProperties(orgChartCss)].filter((name) => !definedProperties.has(name));
    expect(missing).toEqual([]);
  });
});
