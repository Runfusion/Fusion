import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLOR_THEMES as CORE_COLOR_THEMES } from "@fusion/core";
import { COLOR_THEMES as DASHBOARD_COLOR_THEMES } from "../components/themeOptions";

const themeDataPath = path.resolve(__dirname, "../public/theme-data.css");
const themeSelectorPath = path.resolve(__dirname, "../components/ThemeSelector.css");
const dashboardIndexPath = path.resolve(__dirname, "../index.html");
const desktopIndexPath = path.resolve(__dirname, "../../../desktop/src/renderer/index.html");

/*
FNXC:DashboardTheming 2026-08-27-04:23:
Flexoki is valid only when core persistence, selector metadata, web/Electron first-paint validators, complete token blocks, and global previews agree. This source contract guards partial registration, which would make a saved selection flash or fall back before hydration.
*/
describe("Flexoki color theme", () => {
  const themeData = readFileSync(themeDataPath, "utf-8");
  const themeSelector = readFileSync(themeSelectorPath, "utf-8");
  const dashboardIndexHtml = readFileSync(dashboardIndexPath, "utf-8");
  const desktopIndexHtml = readFileSync(desktopIndexPath, "utf-8");

  it("keeps persisted, selector, and first-paint registries in exact order", () => {
    const coreIds = [...CORE_COLOR_THEMES];
    const dashboardIds = DASHBOARD_COLOR_THEMES.map((theme) => theme.value);
    const dashboardValidThemes = extractValidThemes(dashboardIndexHtml);
    const desktopValidThemes = extractValidThemes(desktopIndexHtml);

    expect(CORE_COLOR_THEMES.filter((theme) => theme === "flexoki")).toHaveLength(1);
    expect(DASHBOARD_COLOR_THEMES).toContainEqual({
      value: "flexoki",
      label: "Flexoki",
      className: "theme-swatch-flexoki",
    });
    expect(dashboardIds).toEqual(coreIds);
    expect(dashboardValidThemes).toEqual(coreIds);
    expect(desktopValidThemes).toEqual(coreIds);
    for (const ids of [coreIds, dashboardIds, dashboardValidThemes, desktopValidThemes]) {
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(dashboardIndexHtml).toContain("colorTheme = 'shadcn-ember'");
    expect(desktopIndexHtml).toContain('colorTheme = "shadcn-ember"');
  });

  it("defines complete readable dark and light Flexoki token blocks without raw alpha", () => {
    const darkBlock = extractSelectorBlock(themeData, '[data-color-theme="flexoki"]');
    const lightBlock = extractSelectorBlock(themeData, '[data-color-theme="flexoki"][data-theme="light"]');
    const requiredTokens = [
      "--bg:", "--surface:", "--card:", "--card-hover:", "--surface-hover:", "--border:",
      "--text:", "--text-muted:", "--text-dim:", "--todo:", "--in-progress:", "--in-progress-rgb:",
      "--in-review:", "--triage:", "--done:", "--color-success:", "--color-warning:",
      "--color-error:", "--color-info:", "--cta-bg:", "--cta-border:", "--cta-text:",
      "--cta-bg-hover:", "--cta-border-hover:", "--cta-glow:", "--accent:", "--accent-text:",
      "--logo-accent:", "--shadow-glow:", "--focus-ring:", "--focus-ring-strong:",
    ];

    for (const block of [darkBlock, lightBlock]) {
      for (const token of requiredTokens) expect(block).toContain(token);
      expect(block).not.toMatch(/rgba?\(/);
    }
    expect(darkBlock).toContain("--bg: #100f0f;");
    expect(darkBlock).toContain("--accent: #4385be;");
    expect(lightBlock).toContain("--bg: #fffcf0;");
    expect(lightBlock).toContain("--accent: #205ea6;");
  });

  it("uses mode-specific global Flexoki preview properties for an unselected swatch", () => {
    const darkGlobals = extractSelectorBlock(themeData, ":root");
    const lightGlobals = extractSelectorBlock(themeData, '[data-theme="light"]');
    const darkSwatch = extractSelectorBlock(themeSelector, ".theme-swatch-flexoki");
    const lightSwatch = extractSelectorBlock(themeSelector, '[data-theme="light"] .theme-swatch-flexoki');

    for (const block of [darkGlobals, lightGlobals]) {
      for (const sample of [1, 2, 3, 4]) expect(block).toContain(`--flexoki-swatch-sample-${sample}:`);
    }
    for (const block of [darkSwatch, lightSwatch]) {
      for (const sample of [1, 2, 3, 4]) {
        expect(block).toContain(`--swatch-sample-${sample}: var(--flexoki-swatch-sample-${sample});`);
      }
      expect(block).not.toContain("var(--accent)");
      expect(block).not.toContain("var(--bg)");
    }
  });
});

function extractValidThemes(html: string): string[] {
  const match = html.match(/var validThemes = \[([\s\S]*?)\];/);
  if (!match) throw new Error("Could not find pre-hydration validThemes array");
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((themeMatch) => themeMatch[1]);
}

function extractSelectorBlock(css: string, selector: string): string {
  const startIdx = css.indexOf(`${selector} {`);
  if (startIdx === -1) throw new Error(`Could not find selector block: ${selector}`);
  const openBraceIdx = css.indexOf("{", startIdx);
  let depth = 1;
  for (let index = openBraceIdx + 1; index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] === "}") depth--;
    if (depth === 0) return css.slice(startIdx, index + 1);
  }
  throw new Error(`Could not find closing brace for selector block: ${selector}`);
}
