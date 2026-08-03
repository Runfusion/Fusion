import { describe, expect, it } from "vitest";
import { COLOR_THEMES as CORE_COLOR_THEMES } from "@fusion/core";
import { COLOR_THEMES as DASHBOARD_COLOR_THEMES } from "../components/themeOptions";
import { readAppFile } from "../test/cssFixture";

/*
FNXC:MidnightTheme 2026-08-03-02:05:
Midnight is complete only when its persisted id, selector metadata, web and Electron first-paint registries, readable mode tokens, and global swatches agree. This contract prevents saved choices from flashing, falling back, or rendering blank previews.
*/
describe("Midnight color theme", () => {
  const themeData = readAppFile("public/theme-data.css");
  const themeSelector = readAppFile("components/ThemeSelector.css");
  const dashboardIndexHtml = readAppFile("index.html");
  const desktopIndexHtml = readAppFile("../../desktop/src/renderer/index.html");

  it("keeps persisted, selector, and first-paint registries in exact order", () => {
    const coreIds = [...CORE_COLOR_THEMES];
    const dashboardIds = DASHBOARD_COLOR_THEMES.map((theme) => theme.value);
    const dashboardValidThemes = extractValidThemes(dashboardIndexHtml);
    const desktopValidThemes = extractValidThemes(desktopIndexHtml);

    expect(CORE_COLOR_THEMES.filter((theme) => theme === "midnight")).toHaveLength(1);
    expect(DASHBOARD_COLOR_THEMES).toContainEqual({
      value: "midnight",
      label: "Midnight",
      className: "theme-swatch-midnight",
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

  it("defines complete readable dark and light Midnight token blocks", () => {
    const darkBlock = extractSelectorBlock(themeData, '[data-color-theme="midnight"]');
    const lightBlock = extractSelectorBlock(themeData, '[data-color-theme="midnight"][data-theme="light"]');
    const requiredTokens = [
      "--bg:", "--surface:", "--card:", "--card-hover:", "--surface-hover:", "--border:", "--text:",
      "--color-success:", "--color-warning:", "--color-error:", "--color-info:", "--cta-bg:", "--cta-text:",
      "--accent:", "--accent-text:", "--focus-ring:", "--focus-ring-strong:", "--shadow-glow:",
    ];

    for (const block of [darkBlock, lightBlock]) {
      for (const token of requiredTokens) expect(block).toContain(token);
    }
    expect(darkBlock).toContain("--bg: #0b1026;");
    expect(darkBlock).toContain("--accent: #a78bfa;");
    expect(darkBlock).toContain("--cta-text: #ffffff;");
    expect(lightBlock).toContain("--bg: #f5f6ff;");
    expect(lightBlock).toContain("--accent: #5134a3;");
    expect(lightBlock).toContain("--cta-text: #ffffff;");
  });

  it("uses mode-specific global Midnight preview properties for an unselected swatch", () => {
    const darkGlobals = extractSelectorBlock(themeData, ":root");
    const lightGlobals = extractSelectorBlock(themeData, '[data-theme="light"]');
    const darkSwatch = extractSelectorBlock(themeSelector, ".theme-swatch-midnight");
    const lightSwatch = extractSelectorBlock(themeSelector, '[data-theme="light"] .theme-swatch-midnight');

    for (const block of [darkGlobals, lightGlobals]) {
      for (const sample of [1, 2, 3, 4]) expect(block).toContain(`--midnight-swatch-sample-${sample}:`);
    }
    for (const block of [darkSwatch, lightSwatch]) {
      for (const sample of [1, 2, 3, 4]) {
        expect(block).toContain(`--swatch-sample-${sample}: var(--midnight-swatch-sample-${sample});`);
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
