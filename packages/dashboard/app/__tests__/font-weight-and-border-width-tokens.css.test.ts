import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadStylesCss, loadThemeDataCss } from "../test/cssFixture";

const appDir = resolve(__dirname, "..");

/*
 * FNXC:DashboardTokens 2026-09-01-08:39:
 * FN-9238 guards font-weight and border-width substitutions because an undefined
 * or mistyped var() makes the complete CSS declaration guaranteed-invalid and
 * silently discarded by the browser. Scan the dashboard corpus recursively so
 * nested component stylesheets cannot escape this invariant.
 */
function listAppCssFiles(): string[] {
  const files: string[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".css")) files.push(path);
    }
  }

  walk(appDir);
  return files.sort();
}

function findTokenDefinitions(source: string): Map<string, string> {
  return new Map([...source.matchAll(/--([\w-]+)\s*:\s*([^;{}]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

function lineForOffset(source: string, offset: number): number {
  return source.slice(0, offset).split(/\r?\n/).length;
}

function firstRootDefinitions(stylesCss: string): Map<string, string> {
  const root = stylesCss.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!root) throw new Error("styles.css must retain its theme-agnostic :root block");
  return findTokenDefinitions(root[1]);
}

function isCssLength(value: string): boolean {
  const normalized = value.trim();
  return normalized === "0"
    || /^[+-]?(?:\d+|\d*\.\d+)(?:px|rem|em)\b/.test(normalized)
    || normalized.startsWith("calc(")
    || normalized.startsWith("var(");
}

describe("dashboard font-weight and border-width token hygiene", () => {
  it("defines every font-weight token used by dashboard stylesheets", () => {
    const definitions = findTokenDefinitions(listAppCssFiles().map((file) => readFileSync(file, "utf8")).join("\n"));
    const violations: string[] = [];

    for (const file of listAppCssFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/font-weight\s*:\s*var\(--([\w-]+)\)/g)) {
        if (!definitions.has(match[1])) {
          violations.push(`${relative(appDir, file)}:${lineForOffset(source, match.index ?? 0)}:${match[0]}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("uses defined CSS lengths in border shorthand width slots", () => {
    const rootDefinitions = firstRootDefinitions(loadStylesCss());
    const violations: string[] = [];
    const borderShorthand = /\b(?:border|border-(?:top|bottom|left|right|block(?:-start|-end)?|inline(?:-start|-end)?))\s*:\s*var\(--([\w-]+)\)/g;

    for (const file of listAppCssFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(borderShorthand)) {
        const token = match[1];
        const value = rootDefinitions.get(token);
        if (!value || !isCssLength(value)) {
          violations.push(`${relative(appDir, file)}:${lineForOffset(source, match.index ?? 0)}:${match[0]} (${token}: ${value ?? "undefined"})`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("retains the repaired root token definitions", () => {
    const definitions = firstRootDefinitions(loadStylesCss());

    expect(definitions.get("font-weight-regular")).toBe("400");
    expect(definitions.get("font-weight-medium")).toBe("500");
    expect(definitions.get("font-weight-semibold")).toBe("600");
    expect(definitions.get("font-weight-bold")).toBe("700");
    expect(definitions.get("btn-border-width")).toBe("1px");
  });

  it("keeps border widths theme-aware while font weights remain theme-agnostic", () => {
    const themeDataCss = loadThemeDataCss();
    const overrides = [...themeDataCss.matchAll(/--btn-border-width:\s*([^;]+);/g)].map((match) => match[1].trim());

    expect(overrides.some((value) => value !== "1px")).toBe(true);
    expect(themeDataCss).not.toMatch(/--font-weight-(?:medium|semibold)\s*:/);
    expect(themeDataCss).toContain("--cozy-cartoon-btn-font-weight: 600;");
  });

  it("keeps repaired mailbox declarations in the injected dashboard CSS cascade", () => {
    const style = document.createElement("style");
    style.textContent = loadAllAppCss();
    document.head.append(style);

    try {
      const badge = document.createElement("span");
      badge.className = "mailbox-kind-badge";
      const report = document.createElement("section");
      report.className = "mailbox-structural-report";
      document.body.append(badge, report);

      // jsdom does not reliably resolve custom properties in computed border widths.
      // The injected source assertions prove the declarations survive the cascade.
      expect(style.textContent).toContain("font-weight: var(--font-weight-medium);");
      expect(style.textContent).toContain("border: var(--btn-border-width) solid var(--border-subtle);");
    } finally {
      style.remove();
    }
  });
});
