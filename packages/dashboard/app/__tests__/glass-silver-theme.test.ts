import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLOR_THEMES as CORE_COLOR_THEMES } from "@fusion/core";
import { COLOR_THEMES as DASHBOARD_COLOR_THEMES } from "../components/themeOptions";

const themeDataPath = path.resolve(__dirname, "../public/theme-data.css");
const dashboardIndexPath = path.resolve(__dirname, "../index.html");
const desktopIndexPath = path.resolve(__dirname, "../../../desktop/src/renderer/index.html");

/*
FNXC:DashboardTheming 2026-07-01-00:00:
Glass Silver is a first-class color theme, so this contract keeps the core union, selector metadata, dashboard/desktop pre-hydration validators, and frosted CSS blocks synchronized.
*/
describe("Glass Silver color theme", () => {
  const themeData = readFileSync(themeDataPath, "utf-8");
  const dashboardIndexHtml = readFileSync(dashboardIndexPath, "utf-8");
  const desktopIndexHtml = readFileSync(desktopIndexPath, "utf-8");

  it("registers the theme in core, dashboard metadata, and both bootstrap validators without duplicates", () => {
    expect(CORE_COLOR_THEMES).toContain("glass-silver");
    expect(DASHBOARD_COLOR_THEMES).toContainEqual({
      value: "glass-silver",
      label: "Glass Silver",
      className: "theme-swatch-glass-silver",
    });
    expect(DASHBOARD_COLOR_THEMES.map((theme) => theme.value)).toEqual([...CORE_COLOR_THEMES]);

    const coreIds = [...CORE_COLOR_THEMES];
    expect(new Set(coreIds).size).toBe(coreIds.length);

    const dashboardValidThemes = extractValidThemes(dashboardIndexHtml);
    const desktopValidThemes = extractValidThemes(desktopIndexHtml);
    expect(dashboardValidThemes).toEqual(coreIds);
    expect(desktopValidThemes).toEqual(coreIds);
    expect(new Set(dashboardValidThemes).size).toBe(dashboardValidThemes.length);
    expect(new Set(desktopValidThemes).size).toBe(desktopValidThemes.length);
    expect(dashboardIndexHtml).toContain("colorTheme = 'shadcn-ember'");
    expect(desktopIndexHtml).toContain('colorTheme = "shadcn-ember"');
  });

  it("defines dark and light frosted silver/gray token blocks", () => {
    const darkBlock = extractSelectorBlock(themeData, '[data-color-theme="glass-silver"]');
    const lightBlock = extractSelectorBlock(themeData, '[data-color-theme="glass-silver"][data-theme="light"]');
    const combined = `${darkBlock}\n${lightBlock}`;

    for (const block of [darkBlock, lightBlock]) {
      expect(block).toContain("--surface-hover:");
      expect(block).toContain("--surface: color-mix(in srgb,");
      expect(block).toContain("--card: color-mix(in srgb,");
      expect(block).toContain("transparent);");
      expect(block).toContain("--cta-bg:");
      expect(block).toContain("--cta-border:");
      expect(block).toContain("--cta-text:");
      expect(block).toContain("--accent:");
      expect(block).toContain("--accent-text:");
      expect(block).toContain("--color-info:");
      expect(block).toContain("--shadow-glow:");
      expect(block).toContain("--focus-ring:");
    }

    expect(darkBlock).toContain("--font-primary:");
    expect(darkBlock).toContain("--radius:");
    expect(darkBlock).toContain("--bg: #101216;");
    expect(darkBlock).toContain("--accent: #d7dde6;");
    expect(darkBlock).toContain("--accent-text: #111318;");
    expect(lightBlock).toContain("--bg: #eef0f3;");
    expect(lightBlock).toContain("--accent: #5f6875;");
    expect(lightBlock).toContain("--accent-text: #ffffff;");
    expect(combined).not.toContain("#c86bff");
    expect(combined).not.toContain("#ff7aa8");
    expect(combined).not.toContain("#9d40cf");
    expect(combined).not.toContain("#c74b7a");
  });

  it("mirrors Glass frosted component overrides and transparent modal overlays", () => {
    const cardBlock = extractGroupedRuleBlock(themeData, '[data-color-theme="glass-silver"] .card,');
    const lightCardBlock = extractGroupedRuleBlock(themeData, '[data-color-theme="glass-silver"][data-theme="light"] .card,');
    const buttonBlock = extractSelectorBlock(themeData, '[data-color-theme="glass-silver"] .btn');
    const primaryBlock = extractGroupedRuleBlock(themeData, '[data-color-theme="glass-silver"] .btn-primary,');
    const hoverBlock = extractGroupedRuleBlock(themeData, '[data-color-theme="glass-silver"] .btn-primary:hover,');
    const lightButtonBlock = extractSelectorBlock(themeData, '[data-color-theme="glass-silver"][data-theme="light"] .btn');
    const overlayBlock = extractSelectorBlock(themeData, '[data-color-theme="glass-silver"] .modal-overlay');

    for (const block of [cardBlock, buttonBlock]) {
      expect(block).toContain("backdrop-filter: blur(");
      expect(block).toContain("-webkit-backdrop-filter: blur(");
      expect(block).toContain("color-mix(in srgb,");
      expect(block).toContain("transparent);");
    }
    expect(lightCardBlock).toContain("color-mix(in srgb,");
    expect(lightCardBlock).toContain("transparent);");
    expect(primaryBlock).toContain("linear-gradient(135deg");
    expect(primaryBlock).toContain("#d7dde6");
    expect(hoverBlock).toContain("linear-gradient(135deg");
    expect(hoverBlock).toContain("box-shadow:");
    expect(lightButtonBlock).toContain("color-mix(in srgb, #ffffff 52%, transparent)");
    expect(overlayBlock).toContain("background: transparent;");
    expect(overlayBlock).toContain("backdrop-filter: none;");
    expect(overlayBlock).toContain("-webkit-backdrop-filter: none;");
    expect(overlayBlock).not.toContain("blur(");
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
  let end = openBraceIdx;
  for (let i = openBraceIdx + 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }

  return css.slice(startIdx, end + 1);
}

function extractGroupedRuleBlock(css: string, selector: string): string {
  const selectorIdx = css.indexOf(selector);
  if (selectorIdx === -1) {
    throw new Error(`Could not find selector in grouped block: ${selector}`);
  }

  const openBraceIdx = css.indexOf("{", selectorIdx);
  let depth = 1;
  let end = openBraceIdx;
  for (let i = openBraceIdx + 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }

  const priorCloseIdx = css.lastIndexOf("}", selectorIdx);
  return css.slice(priorCloseIdx + 1, end + 1);
}
