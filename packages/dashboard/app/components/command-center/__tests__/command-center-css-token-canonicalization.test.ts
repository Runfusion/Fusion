import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const COMMAND_CENTER_ROOT = path.resolve(__dirname, "..");

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
});
