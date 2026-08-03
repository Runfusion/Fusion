import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const COMMAND_CENTER_ROOT = path.resolve(__dirname, "..");
const AREAS_CSS_PATH = path.join(COMMAND_CENTER_ROOT, "areas", "areas.css");

function collectCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      out.push(...collectCssFiles(fullPath));
      continue;
    }
    if (entry.endsWith(".css")) {
      out.push(path.relative(COMMAND_CENTER_ROOT, fullPath).split(path.sep).join("/"));
    }
  }
  return out;
}

describe("Command Center CSS token canonicalization", () => {
  it("keeps undefined accent and primary text aliases out of Command Center CSS", () => {
    const offenders: string[] = [];
    for (const relPath of collectCssFiles(COMMAND_CENTER_ROOT)) {
      const content = readFileSync(path.join(COMMAND_CENTER_ROOT, relPath), "utf8");
      if (/--(?:color-accent|text-primary)\b/.test(content)) offenders.push(relPath);
    }

    expect(offenders, `Unexpected undefined Command Center token aliases in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps chart primitives wired to canonical accent and text tokens", () => {
    const chartsCss = readFileSync(path.join(COMMAND_CENTER_ROOT, "charts/charts.css"), "utf8");

    expect(chartsCss).toContain("var(--accent)");
    expect(chartsCss).toContain("var(--text)");
  });

  it("scopes the resolved GitHub table contract to tokenized responsive selectors", () => {
    const areasCss = readFileSync(AREAS_CSS_PATH, "utf8");
    const resolvedTableCss = areasCss.match(/\.cc-github-resolved-table-wrap[\s\S]*?(?=\.cc-sort-caret)/)?.[0];

    expect(resolvedTableCss).toBeTruthy();
    expect(resolvedTableCss).toContain(".cc-github-resolved-table");
    expect(resolvedTableCss).toContain("table-layout: fixed");
    expect(resolvedTableCss).toContain("overflow-wrap: anywhere");
    expect(resolvedTableCss).toContain("var(--accent)");
    expect(resolvedTableCss).toContain("var(--focus-ring)");
    expect(resolvedTableCss).toContain("@media (max-width: 768px)");
    expect(resolvedTableCss).not.toMatch(/\b\d+px\s*;|#[0-9a-f]{3,8}\b|rgba\(/i);
  });
});
