import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = path.resolve(__dirname, "..");
const COMPONENTS_ROOT = path.join(APP_ROOT, "components");

const JS_SET_PROPERTY_ALLOWLIST = new Set([
  "--cc-radial-value",
  "--mobile-wf-depth",
  "--icb-bottom-offset",
  "--icb-right-offset",
  "--quick-chat-fab-lift",
  "--quick-chat-fab-shadow",
  "--quick-chat-fab-shadow-hover",
  "--selection-comment-panel-width",
  "--task-chat-composer-max-height",
  "--layout-content-max-width",
  "--opacity-disabled",
  "--provider-icon-color",
]);

/**
 * FNXC:DashboardStyling 2026-06-19-00:00:
 * FN-6690/FN-6693 proved jsdom style assertions miss undefined CSS custom-property references because jsdom does not resolve `var()` at computed-value time.
 * Scan raw dashboard CSS instead: a bare `var(--missing-token)` can silently invalidate a declaration or depend on a stale fallback, so every referenced custom property must be defined by CSS, assigned by React inline style, or documented as a runtime-local allowlist entry.
 */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function collectFiles(dir: string, predicate: (fileName: string) => boolean): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "public" || entry.startsWith(".")) continue;

    const fullPath = path.join(dir, entry);
    const info = statSync(fullPath);

    if (info.isDirectory()) {
      out.push(...collectFiles(fullPath, predicate));
      continue;
    }

    if (info.isFile() && predicate(entry)) out.push(fullPath);
  }

  return out.sort((left, right) => formatAppPath(left).localeCompare(formatAppPath(right)));
}

function collectCssFilesToScan(): string[] {
  const componentCss = collectFiles(COMPONENTS_ROOT, (fileName) => fileName.endsWith(".css"));
  const appLevelCss = readdirSync(APP_ROOT)
    .filter((entry) => entry.endsWith(".css") && entry !== "styles.css")
    .map((entry) => path.join(APP_ROOT, entry));

  return [...componentCss, ...appLevelCss].sort((left, right) => formatAppPath(left).localeCompare(formatAppPath(right)));
}

function collectAllCssFiles(): string[] {
  return collectFiles(APP_ROOT, (fileName) => fileName.endsWith(".css"));
}

function collectSourceFiles(): string[] {
  return collectFiles(APP_ROOT, (fileName) => /\.(tsx?|jsx?)$/.test(fileName));
}

function collectDefinedProperties(cssFiles: string[]): Set<string> {
  const properties = new Set<string>();

  for (const filePath of cssFiles) {
    const source = stripCssComments(readFileSync(filePath, "utf8"));
    for (const match of source.matchAll(/(^|[\s{;])(--[A-Za-z0-9_-]+)\s*:/g)) {
      properties.add(match[2]);
    }
  }

  return properties;
}

function collectInlineSetProperties(sourceFiles: string[]): Set<string> {
  const properties = new Set<string>();

  for (const filePath of sourceFiles) {
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/\[\s*["'`](--[A-Za-z0-9_-]+)["'`]\s*(?:as\s+string)?\s*\]\s*:/g)) {
      properties.add(match[1]);
    }
    for (const match of source.matchAll(/["'`](--[A-Za-z0-9_-]+)["'`]\s*:/g)) {
      properties.add(match[1]);
    }
  }

  return properties;
}

function collectReferencedProperties(source: string): Set<string> {
  const references = new Set<string>();
  const uncommented = stripCssComments(source);

  for (const match of uncommented.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
    references.add(match[1]);
  }

  return references;
}

function formatAppPath(filePath: string): string {
  return path.relative(APP_ROOT, filePath).split(path.sep).join("/");
}

function findUndefinedReferences(args: {
  cssFilesToScan: string[];
  definedProperties: Set<string>;
  inlineSetProperties: Set<string>;
  allowlist?: Set<string>;
  sourceByFile?: Map<string, string>;
}): string[] {
  const {
    cssFilesToScan,
    definedProperties,
    inlineSetProperties,
    allowlist = JS_SET_PROPERTY_ALLOWLIST,
    sourceByFile = new Map(),
  } = args;
  const violations: string[] = [];

  for (const filePath of cssFilesToScan) {
    const source = sourceByFile.get(filePath) ?? readFileSync(filePath, "utf8");
    for (const property of collectReferencedProperties(source)) {
      if (definedProperties.has(property) || inlineSetProperties.has(property) || allowlist.has(property)) continue;
      violations.push(`${formatAppPath(filePath)} references ${property}`);
    }
  }

  return violations.sort();
}

describe("dashboard CSS token validity", () => {
  it("flags a synthetic undefined custom-property reference", () => {
    const fixturePath = path.join(APP_ROOT, "fixture.css");
    const fixtureSource = "/* var(--commented-out) */ .x { color: var(--does-not-exist); }";
    const violations = findUndefinedReferences({
      cssFilesToScan: [fixturePath],
      definedProperties: new Set(["--defined-token"]),
      inlineSetProperties: new Set(),
      allowlist: new Set(),
      sourceByFile: new Map([[fixturePath, fixtureSource]]),
    });

    expect(collectReferencedProperties(fixtureSource)).toEqual(new Set(["--does-not-exist"]));
    expect(violations).toEqual(["fixture.css references --does-not-exist"]);
  });

  it("keeps component and app-level CSS references backed by defined or runtime-set properties", () => {
    const violations = findUndefinedReferences({
      cssFilesToScan: collectCssFilesToScan(),
      definedProperties: collectDefinedProperties(collectAllCssFiles()),
      inlineSetProperties: collectInlineSetProperties(collectSourceFiles()),
    });

    expect(violations, [`Undefined CSS custom-property references found:`, ...violations].join("\n")).toEqual([]);
  });
});
