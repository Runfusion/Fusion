/*
FNXC:EngineControls 2026-06-21-00:00:
FN-6862 guards the footer engine-control popover at raw CSS-text level because jsdom does not resolve undefined custom properties. The popover must keep an opaque dashboard surface (`var(--card)`) and this component stylesheet must not reference custom properties absent from the dashboard CSS vocabulary.
*/
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = resolve(__dirname, "..", "..");
const COMPONENT_CSS = join(APP_DIR, "components", "EngineControlMenu.css");
const STYLES_CSS = join(APP_DIR, "styles.css");
const THEME_DATA_CSS = join(APP_DIR, "public", "theme-data.css");
const RUNTIME_DEFINED_PROPERTIES = new Set(["--icb-bottom-offset"]);

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function collectCssFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const fullPath = join(dir, entry);
    const info = statSync(fullPath);
    if (info.isDirectory()) {
      files.push(...collectCssFiles(fullPath));
    } else if (info.isFile() && entry.endsWith(".css")) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectDefinedProperties(css: string, into: Set<string>): void {
  const uncommented = stripCssComments(css);
  for (const match of uncommented.matchAll(/(^|[\s{;])(--[A-Za-z0-9_-]+)\s*:/g)) {
    into.add(match[2]);
  }
}

function collectReferencedProperties(css: string): Map<string, number[]> {
  const refs = new Map<string, number[]>();
  stripCssComments(css)
    .split("\n")
    .forEach((line, index) => {
      for (const match of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
        const name = match[1];
        const lineNumbers = refs.get(name) ?? [];
        lineNumbers.push(index + 1);
        refs.set(name, lineNumbers);
      }
    });
  return refs;
}

function extractRuleBlock(css: string, selector: string): string {
  const ruleStart = css.indexOf(`${selector} {`);
  expect(ruleStart, `Expected ${selector} to exist in EngineControlMenu.css`).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", ruleStart);
  let braceCount = 1;
  let bodyEnd = bodyStart + 1;
  while (braceCount > 0 && bodyEnd < css.length) {
    if (css[bodyEnd] === "{") braceCount += 1;
    if (css[bodyEnd] === "}") braceCount -= 1;
    bodyEnd += 1;
  }
  expect(braceCount, `Expected ${selector} rule to have a closing brace`).toBe(0);
  return css.slice(bodyStart + 1, bodyEnd - 1);
}

function extractMobileMediaBlocks(css: string): string {
  const blocks: string[] = [];
  const regex = /@media[^{}]*\(max-width:\s*1024px\)[^{]*\{/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(css)) !== null) {
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let endIdx = startIdx;
    while (braceCount > 0 && endIdx < css.length) {
      if (css[endIdx] === "{") braceCount += 1;
      if (css[endIdx] === "}") braceCount -= 1;
      endIdx += 1;
    }
    if (braceCount === 0) {
      blocks.push(css.slice(startIdx, endIdx - 1));
    }
  }

  return blocks.join("\n");
}

function extractMediaBlocksForWidth(css: string, width: string): string {
  const blocks: string[] = [];
  const regex = new RegExp(`@media[^{}]*\\(max-width:\\s*${width}\\)[^{]*\\{`, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(css)) !== null) {
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let endIdx = startIdx;
    while (braceCount > 0 && endIdx < css.length) {
      if (css[endIdx] === "{") braceCount += 1;
      if (css[endIdx] === "}") braceCount -= 1;
      endIdx += 1;
    }
    if (braceCount === 0) {
      blocks.push(css.slice(startIdx, endIdx - 1));
    }
  }

  return blocks.join("\n");
}

function normalizeCss(css: string): string {
  return css.replace(/\s+/g, " ").trim();
}

describe("EngineControlMenu CSS token validity (FN-6862)", () => {
  const componentCss = readFileSync(COMPONENT_CSS, "utf8");
  const stylesCss = readFileSync(STYLES_CSS, "utf8");
  const themeDataCss = readFileSync(THEME_DATA_CSS, "utf8");

  const defined = new Set<string>();
  collectDefinedProperties(stylesCss, defined);
  collectDefinedProperties(themeDataCss, defined);
  for (const cssFile of collectCssFiles(APP_DIR)) {
    collectDefinedProperties(readFileSync(cssFile, "utf8"), defined);
  }

  it("uses the defined solid card token for the footer popover background", () => {
    expect(defined.has("--card"), "--card must be part of the dashboard token vocabulary").toBe(true);
    expect(stylesCss, "styles.css should define --card for the default and light themes").toMatch(/--card\s*:/);
    expect(themeDataCss, "theme-data.css should define --card for theme-generated palettes").toMatch(/--card\s*:/);

    const popoverBlock = extractRuleBlock(componentCss, ".engine-control-menu__popover");
    expect(popoverBlock).toMatch(/(^|\n)\s*background\s*:\s*var\(--card\)\s*;/);
  });

  it("does not reference the undefined elevated surface token", () => {
    expect(componentCss).not.toContain("--surface-elevated");
  });

  it("references only defined dashboard custom properties", () => {
    const violations: string[] = [];
    for (const [name, lineNumbers] of collectReferencedProperties(componentCss)) {
      if (!defined.has(name) && !RUNTIME_DEFINED_PROPERTIES.has(name)) {
        violations.push(`${relative(APP_DIR, COMPONENT_CSS)}: var(${name}) at line(s) ${lineNumbers.join(", ")}`);
      }
    }

    expect(violations, `Undefined CSS custom properties referenced in EngineControlMenu.css:\n${violations.join("\n")}`).toEqual([]);
  });

  it("renders the mobile and narrow-tablet footer popover as a viewport-safe bottom panel", () => {
    expect(componentCss).toContain("@media (max-width: 1024px)");
    /*
    FNXC:EngineControls 2026-07-07-08:20:
    FN-7340 added a @media (max-width: 768px) block for range-slider thumb touch-target sizing — a separate concern from popover placement, which stays on the 1024px breakpoint (extractMobileMediaBlocks). The earlier whole-file ban on "@media (max-width: 768px)" was too broad; assert instead that the 768px block never repositions the popover.
    */
    expect(extractMediaBlocksForWidth(componentCss, "768px")).not.toContain(".engine-control-menu__popover");

    const desktopPopoverBlock = normalizeCss(extractRuleBlock(componentCss, ".engine-control-menu__popover"));
    const footerDesktopPopoverBlock = normalizeCss(
      extractRuleBlock(componentCss, ".executor-status-bar__segment--engine-controls .engine-control-menu > .engine-control-menu__popover.card"),
    );
    const mobileCss = extractMobileMediaBlocks(componentCss);
    const mobilePopoverBlock = normalizeCss(extractRuleBlock(mobileCss, ".engine-control-menu__popover"));
    const footerSpecificMobilePopoverBlock = normalizeCss(
      extractRuleBlock(mobileCss, ".executor-status-bar__segment--engine-controls .engine-control-menu > .engine-control-menu__popover.card"),
    );

    expect(desktopPopoverBlock).toContain("position: absolute");
    expect(desktopPopoverBlock).toContain("right: 0");
    expect(desktopPopoverBlock).toContain("width: min(24rem");
    expect(footerDesktopPopoverBlock).toContain("position: absolute");
    expect(footerDesktopPopoverBlock).toContain("right: 0");
    expect(footerDesktopPopoverBlock).toContain("bottom: calc(100% + var(--space-xs))");

    for (const block of [mobilePopoverBlock, footerSpecificMobilePopoverBlock]) {
      expect(block).toContain("position: fixed");
      expect(block).toContain("left: var(--space-sm)");
      expect(block).toContain("right: var(--space-sm)");
      expect(block).toContain("width: auto");
      expect(block).toContain("overflow: auto");
      expect(block).toContain("max-height: min(");
      expect(block).toContain("var(--executor-footer-height)");
      expect(block).toContain("var(--mobile-nav-height)");
      expect(block).toContain("max(env(safe-area-inset-bottom, 0px), var(--space-md))");
      expect(block).toContain("var(--standalone-bottom-gap)");
      expect(block).toContain("var(--icb-bottom-offset, 0px)");
      expect(block).not.toContain("right: 0");
      expect(block).not.toContain("width: min(24rem");
    }
  });

  it("keeps the footer-specific mobile override after the base mobile panel rule", () => {
    const mobileCss = extractMobileMediaBlocks(componentCss);
    const baseRuleIndex = mobileCss.indexOf(".engine-control-menu__popover {");
    const footerRuleIndex = mobileCss.indexOf(".executor-status-bar__segment--engine-controls .engine-control-menu > .engine-control-menu__popover.card {");

    expect(baseRuleIndex).toBeGreaterThanOrEqual(0);
    expect(footerRuleIndex).toBeGreaterThan(baseRuleIndex);
  });
});
