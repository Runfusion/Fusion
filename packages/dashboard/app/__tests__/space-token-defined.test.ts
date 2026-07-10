import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appDir = resolve(__dirname, "..");
const componentsDir = resolve(appDir, "components");
const stylesPath = resolve(appDir, "styles.css");
const themeDataPath = resolve(appDir, "public/theme-data.css");

/*
 * FNXC:DashboardTokens 2026-07-08-00:00:
 * FN-7681 found --space-2xs references escaping this guard inside a
 * subdirectory stylesheet (settings/sections/McpServersCard.css) because the
 * original scan was non-recursive. Walk componentsDir recursively (bounded,
 * no temp-root traversal) so every component CSS file is covered, while
 * skipping __tests__ directories and non-.css files.
 */
function listComponentCssFiles(): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue;
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".css")) {
        results.push(entryPath);
      }
    }
  }

  walk(componentsDir);
  return results.sort();
}

describe("dashboard spacing token hygiene", () => {
  it("does not reference undefined --space-2xs in any component stylesheet", () => {
    const violations: string[] = [];

    for (const filePath of listComponentCssFiles()) {
      const relativePath = filePath.slice(componentsDir.length + 1);
      const source = readFileSync(filePath, "utf8");
      const lines = source.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].includes("var(--space-2xs)")) {
          violations.push(`${relativePath}:${index + 1}:${lines[index].trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("documents that --space-2xs remains intentionally undefined in shared token sources", () => {
    const tokenSources = [
      { name: "styles.css", source: readFileSync(stylesPath, "utf8") },
      { name: "theme-data.css", source: readFileSync(themeDataPath, "utf8") },
    ];

    for (const { name, source } of tokenSources) {
      expect(source).not.toContain("--space-2xs:");
    }
  });
});
