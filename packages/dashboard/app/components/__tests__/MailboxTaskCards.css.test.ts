import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = resolve(__dirname, "..", "..");
const RECOMMENDATIONS_CSS = join(APP_DIR, "components", "MailboxTaskRecommendations.css");
const PROPOSAL_CSS = join(APP_DIR, "components", "MailboxTaskProposal.css");
const STYLES_CSS = join(APP_DIR, "styles.css");
const THEME_DATA_CSS = join(APP_DIR, "public", "theme-data.css");

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function collectCssFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const fullPath = join(dir, entry);
    const info = statSync(fullPath);
    if (info.isDirectory()) files.push(...collectCssFiles(fullPath));
    else if (info.isFile() && entry.endsWith(".css")) files.push(fullPath);
  }
  return files;
}

function collectDefinedProperties(css: string, into: Set<string>): void {
  for (const match of stripCssComments(css).matchAll(/(^|[\s{;])(--[A-Za-z0-9_-]+)\s*:/g)) into.add(match[2]);
}

function collectReferencedProperties(css: string): Map<string, number[]> {
  const references = new Map<string, number[]>();
  stripCssComments(css).split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      const lines = references.get(match[1]) ?? [];
      lines.push(index + 1);
      references.set(match[1], lines);
    }
  });
  return references;
}

function extractRuleBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `Expected ${selector} rule`).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", start);
  let depth = 1;
  let end = bodyStart + 1;
  while (depth > 0 && end < css.length) {
    if (css[end] === "{") depth += 1;
    if (css[end] === "}") depth -= 1;
    end += 1;
  }
  expect(depth, `Expected ${selector} to close`).toBe(0);
  return css.slice(bodyStart + 1, end - 1);
}

function extractMobileBlock(css: string): string {
  const match = /@media\s*\(max-width:\s*768px\)\s*\{/.exec(css);
  expect(match, "Expected a max-width: 768px media block").not.toBeNull();
  const start = match!.index + match![0].length;
  let depth = 1;
  let end = start;
  while (depth > 0 && end < css.length) {
    if (css[end] === "{") depth += 1;
    if (css[end] === "}") depth -= 1;
    end += 1;
  }
  expect(depth, "Expected mobile media block to close").toBe(0);
  return css.slice(start, end - 1);
}

function expectDefinedReferences(file: string, css: string, defined: Set<string>): void {
  const violations: string[] = [];
  for (const [name, lines] of collectReferencedProperties(css)) {
    if (!defined.has(name)) violations.push(`${relative(APP_DIR, file)}: var(${name}) at line(s) ${lines.join(", ")}`);
  }
  expect(violations, `Undefined CSS custom properties:\n${violations.join("\n")}`).toEqual([]);
}

function expectTokenizedBorders(css: string): void {
  for (const line of stripCssComments(css).split("\n")) {
    const declaration = /^\s*border(?!-radius)(?:-[a-z]+)?\s*:\s*(.+);\s*$/.exec(line);
    if (declaration) expect(declaration[1]).toMatch(/^var\(--btn-border-width\)/);
  }
}

describe("Mailbox task-card CSS token validity (FN-9224)", () => {
  const recommendationsCss = readFileSync(RECOMMENDATIONS_CSS, "utf8");
  const proposalCss = readFileSync(PROPOSAL_CSS, "utf8");
  const defined = new Set<string>();
  collectDefinedProperties(readFileSync(STYLES_CSS, "utf8"), defined);
  collectDefinedProperties(readFileSync(THEME_DATA_CSS, "utf8"), defined);
  for (const file of collectCssFiles(APP_DIR)) collectDefinedProperties(readFileSync(file, "utf8"), defined);

  it("references only defined dashboard properties and excludes the retired names", () => {
    expectDefinedReferences(RECOMMENDATIONS_CSS, recommendationsCss, defined);
    expectDefinedReferences(PROPOSAL_CSS, proposalCss, defined);
    for (const name of ["--space-2", "--space-3", "--border-width", "--color-border", "--color-surface"]) {
      expect(recommendationsCss).not.toContain(name);
      expect(proposalCss).not.toContain(name);
    }
  });

  it("uses the button border-width token for every border shorthand", () => {
    expectTokenizedBorders(recommendationsCss);
    expectTokenizedBorders(proposalCss);
  });

  it("owns padded, bordered, typed desktop card treatments", () => {
    const recommendationItem = extractRuleBlock(recommendationsCss, ".mailbox-task-recommendations__item");
    const proposal = extractRuleBlock(proposalCss, ".mailbox-task-proposal");
    expect(recommendationItem).toMatch(/padding:\s*var\(--space-/);
    expect(recommendationItem).toMatch(/gap:\s*var\(--space-/);
    expect(recommendationItem).toMatch(/border-radius:/);
    expect(recommendationItem).toMatch(/background:/);
    expect(recommendationItem).toMatch(/border:/);
    expect(proposal).toMatch(/padding:\s*var\(--space-/);
    expect(proposal).toMatch(/border-radius:/);

    for (const [css, selector] of [
      [recommendationsCss, ".mailbox-task-recommendations__heading h3"],
      [recommendationsCss, ".mailbox-task-recommendations__content p"],
      [recommendationsCss, ".mailbox-task-recommendations__heading span"],
      [proposalCss, ".mailbox-task-proposal strong"],
      [proposalCss, ".mailbox-task-proposal p"],
    ] as const) expect(extractRuleBlock(css, selector)).toMatch(/font-size:\s*var\(--font-size-/);

    for (const selector of [".mailbox-task-recommendations__error", ".mailbox-task-recommendations__unavailable"]) {
      const rule = extractRuleBlock(recommendationsCss, selector);
      expect(rule).toMatch(/color:\s*var\(--(?:color-|text-)/);
      expect(rule).toMatch(/font-size:\s*var\(--font-size-/);
    }
  });

  it("keeps compact tokenized mobile cards and full-width actions", () => {
    for (const [css, root, button] of [
      [recommendationsCss, ".mailbox-task-recommendations__item", ".mailbox-task-recommendations .btn"],
      [proposalCss, ".mailbox-task-proposal", ".mailbox-task-proposal .btn"],
    ] as const) {
      const mobile = extractMobileBlock(css);
      expectDefinedReferences(root, mobile, defined);
      expect(extractRuleBlock(mobile, root)).toMatch(/padding:\s*var\(--space-sm\)/);
      expect(extractRuleBlock(mobile, button)).toMatch(/inline-size:\s*100%/);
    }
  });
});
