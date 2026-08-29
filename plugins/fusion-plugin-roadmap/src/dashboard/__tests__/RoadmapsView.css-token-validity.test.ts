import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TEST_DIR = __dirname;
const REPO_ROOT = path.resolve(TEST_DIR, "../../../../../");
const DASHBOARD_APP_ROOT = path.join(REPO_ROOT, "packages/dashboard/app");
const DASHBOARD_COMPONENTS_ROOT = path.join(DASHBOARD_APP_ROOT, "components");
const ROADMAP_CSS = path.resolve(TEST_DIR, "../RoadmapsView.css");
const RETIRED_TOKEN_REFERENCES = ["--surface-elevated", "--surface-input", "--text-primary"];

/**
 * FNXC:RoadmapStyling 2026-06-21-00:00:
 * FN-6867 guards roadmap plugin CSS with a raw-text token scan because jsdom does not resolve custom properties.
 * Roadmap surfaces and text must reference dashboard-defined tokens so sidebar, lane, form, feature-card, and suggestion surfaces remain opaque in every theme.
 */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function collectFiles(dir: string, predicate: (fileName: string) => boolean): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__" || entry.startsWith(".")) continue;

    const fullPath = path.join(dir, entry);
    const info = statSync(fullPath);

    if (info.isDirectory()) {
      out.push(...collectFiles(fullPath, predicate));
      continue;
    }

    if (info.isFile() && predicate(entry)) out.push(fullPath);
  }

  return out.sort((left, right) => formatRepoPath(left).localeCompare(formatRepoPath(right)));
}

function collectDashboardVocabularyCssFiles(): string[] {
  const appLevelCss = readdirSync(DASHBOARD_APP_ROOT)
    .filter((entry) => entry.endsWith(".css"))
    .map((entry) => path.join(DASHBOARD_APP_ROOT, entry));
  const componentCss = collectFiles(DASHBOARD_COMPONENTS_ROOT, (fileName) => fileName.endsWith(".css"));
  const themeDataCss = [path.join(DASHBOARD_APP_ROOT, "public/theme-data.css")];

  return [...appLevelCss, ...themeDataCss, ...componentCss].sort((left, right) =>
    formatRepoPath(left).localeCompare(formatRepoPath(right)),
  );
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

function collectReferencedProperties(source: string): Map<string, number[]> {
  const references = new Map<string, number[]>();
  const uncommented = stripCssComments(source);

  uncommented.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      const property = match[1];
      const lines = references.get(property) ?? [];
      lines.push(index + 1);
      references.set(property, lines);
    }
  });

  return references;
}

function findUndefinedReferences(args: {
  cssFilesToScan: string[];
  definedProperties: Set<string>;
  sourceByFile?: Map<string, string>;
}): string[] {
  const { cssFilesToScan, definedProperties, sourceByFile = new Map() } = args;
  const violations: string[] = [];

  for (const filePath of cssFilesToScan) {
    const source = sourceByFile.get(filePath) ?? readFileSync(filePath, "utf8");
    for (const [property, lines] of collectReferencedProperties(source)) {
      if (definedProperties.has(property)) continue;
      violations.push(`${formatRepoPath(filePath)} references ${property} at line(s) ${lines.join(", ")}`);
    }
  }

  return violations.sort();
}

function formatRepoPath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

describe("RoadmapsView CSS token validity (FN-6867)", () => {
  it("flags a synthetic undefined custom-property reference", () => {
    const fixturePath = path.join(REPO_ROOT, "fixture.css");
    const fixtureSource = "/* var(--commented-out) */ .x { color: var(--does-not-exist); background: var(--defined-token); }";
    const violations = findUndefinedReferences({
      cssFilesToScan: [fixturePath],
      definedProperties: new Set(["--defined-token"]),
      sourceByFile: new Map([[fixturePath, fixtureSource]]),
    });

    expect(collectReferencedProperties(fixtureSource)).toEqual(
      new Map([
        ["--does-not-exist", [1]],
        ["--defined-token", [1]],
      ]),
    );
    expect(violations).toEqual(["fixture.css references --does-not-exist at line(s) 1"]);
  });

  it("does not reintroduce retired roadmap surface or text token aliases", () => {
    const css = readFileSync(ROADMAP_CSS, "utf8");
    const offenders = RETIRED_TOKEN_REFERENCES.filter((token) => css.includes(token));

    expect(
      offenders,
      `RoadmapsView.css must use --card, --surface, and --text instead of retired aliases: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("references only dashboard-defined or RoadmapsView-local custom properties", () => {
    const dashboardVocabularyCssFiles = collectDashboardVocabularyCssFiles();
    const definedProperties = collectDefinedProperties([...dashboardVocabularyCssFiles, ROADMAP_CSS]);
    const violations = findUndefinedReferences({
      cssFilesToScan: [ROADMAP_CSS],
      definedProperties,
    });

    expect(dashboardVocabularyCssFiles).toContain(path.join(DASHBOARD_APP_ROOT, "styles.css"));
    expect(dashboardVocabularyCssFiles).toContain(path.join(DASHBOARD_APP_ROOT, "public/theme-data.css"));
    expect(Array.from(definedProperties)).toEqual(expect.arrayContaining(["--card", "--surface", "--text"]));
    expect(violations, [`Undefined CSS custom-property references found in RoadmapsView.css:`, ...violations].join("\n")).toEqual([]);
  });
});
