import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLOR_THEMES as CORE_COLOR_THEMES } from "@fusion/core";
import { COLOR_THEMES as DASHBOARD_COLOR_THEMES } from "../components/themeOptions";

const themeDataPath = path.resolve(__dirname, "../public/theme-data.css");
const themeSelectorPath = path.resolve(__dirname, "../components/ThemeSelector.css");
const dashboardIndexPath = path.resolve(__dirname, "../index.html");
const desktopIndexPath = path.resolve(__dirname, "../../../desktop/src/renderer/index.html");

const newThemes = [
  { value: "aurora", label: "Aurora" },
  { value: "volcanic", label: "Volcanic" },
  { value: "glacier", label: "Glacier" },
  { value: "cobalt", label: "Cobalt" },
  { value: "clay", label: "Clay" },
  { value: "moss", label: "Moss" },
] as const;

/*
FNXC:DashboardTheming 2026-07-16-00:00:
FN-8151 requires every theme id to stay registered in the core union, selector metadata, both pre-hydration validators, token blocks, and swatch CSS. This invariant-level contract prevents a partial theme from shipping.
*/
describe("Cobalt, Clay, and Moss color themes", () => {
  const themeData = readFileSync(themeDataPath, "utf-8");
  const themeSelector = readFileSync(themeSelectorPath, "utf-8");
  const dashboardIndexHtml = readFileSync(dashboardIndexPath, "utf-8");
  const desktopIndexHtml = readFileSync(desktopIndexPath, "utf-8");

  it("keeps core, selector metadata, and bootstrap validators in exact order without duplicates", () => {
    const coreIds = [...CORE_COLOR_THEMES];
    const dashboardIds = DASHBOARD_COLOR_THEMES.map((theme) => theme.value);
    const dashboardValidThemes = extractValidThemes(dashboardIndexHtml);
    const desktopValidThemes = extractValidThemes(desktopIndexHtml);

    for (const { value, label } of newThemes) {
      expect(CORE_COLOR_THEMES).toContain(value);
      expect(DASHBOARD_COLOR_THEMES).toContainEqual({
        value,
        label,
        className: `theme-swatch-${value}`,
      });
      expect(dashboardValidThemes).toContain(value);
      expect(desktopValidThemes).toContain(value);
    }

    expect(dashboardIds).toEqual(coreIds);
    expect(dashboardValidThemes).toEqual(coreIds);
    expect(desktopValidThemes).toEqual(coreIds);
    for (const ids of [coreIds, dashboardIds, dashboardValidThemes, desktopValidThemes]) {
      expect(new Set(ids).size).toBe(ids.length);
    }

    expect(dashboardIndexHtml).toContain("colorTheme = 'shadcn-ember'");
    expect(desktopIndexHtml).toContain('colorTheme = "shadcn-ember"');
  });

  it("defines complete dark and light token blocks and swatch samples for every new theme", () => {
    const requiredTokens = [
      "--bg:",
      "--surface:",
      "--card:",
      "--cta-bg:",
      "--accent:",
      "--accent-text:",
      "--color-info:",
    ];
    const requiredSwatchSamples = [
      "--swatch-sample-1:",
      "--swatch-sample-2:",
      "--swatch-sample-3:",
      "--swatch-sample-4:",
    ];

    for (const { value } of newThemes) {
      const darkBlock = extractSelectorBlock(themeData, `[data-color-theme="${value}"]`);
      const lightBlock = extractSelectorBlock(themeData, `[data-color-theme="${value}"][data-theme="light"]`);
      const swatchBlock = extractSelectorBlock(themeSelector, `.theme-swatch-${value}`);

      for (const block of [darkBlock, lightBlock]) {
        for (const token of requiredTokens) {
          expect(block).toContain(token);
        }
      }
      for (const sample of requiredSwatchSamples) {
        expect(swatchBlock).toContain(sample);
      }
    }
  });
});

function extractValidThemes(html: string): string[] {
  const match = html.match(/var validThemes = \[([\s\S]*?)\];/);
  if (!match) {
    throw new Error("Could not find pre-hydration validThemes array");
  }

  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((themeMatch) => themeMatch[1]);
}

function extractSelectorBlock(css: string, selector: string): string {
  const startIdx = css.indexOf(`${selector} {`);
  if (startIdx === -1) {
    throw new Error(`Could not find selector block: ${selector}`);
  }

  const openBraceIdx = css.indexOf("{", startIdx);
  let depth = 1;
  for (let index = openBraceIdx + 1; index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] === "}") depth--;
    if (depth === 0) {
      return css.slice(startIdx, index + 1);
    }
  }

  throw new Error(`Could not find closing brace for selector block: ${selector}`);
}
