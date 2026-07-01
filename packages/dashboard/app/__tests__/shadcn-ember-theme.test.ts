import { describe, expect, it } from "vitest";
import { COLOR_THEMES as CORE_COLOR_THEMES } from "@fusion/core";
import { COLOR_THEMES as DASHBOARD_COLOR_THEMES } from "../components/themeOptions";
import fs from "fs";
import path from "path";

const themeDataPath = path.resolve(__dirname, "../public/theme-data.css");
const dashboardIndexPath = path.resolve(__dirname, "../index.html");
const desktopIndexPath = path.resolve(__dirname, "../../../desktop/src/renderer/index.html");

/*
FNXC:DashboardTheming 2026-06-30-00:00:
Shadcn Ember is the default color-theme contract. Tests assert source-of-truth CSS and every bootstrap validator so unset/invalid installs converge on Shadcn Ember while explicit legacy ids remain valid.
*/
describe("Shadcn Ember color theme", () => {
  const themeData = fs.readFileSync(themeDataPath, "utf-8");
  const dashboardIndex = fs.readFileSync(dashboardIndexPath, "utf-8");
  const desktopIndex = fs.readFileSync(desktopIndexPath, "utf-8");

  it("defines dark and light shadcn structure with Ember color tokens", () => {
    const darkBlock = extractSelectorBlock(themeData, '[data-color-theme="shadcn-ember"]');
    const lightBlock = extractSelectorBlock(themeData, '[data-color-theme="shadcn-ember"][data-theme="light"]');

    expect(darkBlock).toContain("--surface-hover:");
    expect(lightBlock).toContain("--surface-hover:");
    expect(darkBlock).toContain("--bg: #09090b;");
    expect(darkBlock).toContain("--card: #18181b;");
    expect(lightBlock).toContain("--bg: #ffffff;");
    expect(lightBlock).toContain("--card-hover: #f4f4f5;");
    expect(darkBlock).toContain("--btn-border-width: 1px;");
    expect(darkBlock).toContain("--font-primary: \"Geist\",");

    expect(darkBlock).toContain("--todo: #a0a0a0;");
    expect(darkBlock).toContain("--in-progress: #b8b8b8;");
    expect(darkBlock).toContain("--color-error: #ff6b6b;");
    expect(darkBlock).toContain("--cta-bg: #d4622a;");
    expect(darkBlock).toContain("--cta-border: #e8773a;");
    expect(darkBlock).toContain("--color-info: #e8773a;");
    expect(darkBlock).toContain("--accent: #e8773a;");

    expect(lightBlock).toContain("--todo: #404040;");
    expect(lightBlock).toContain("--in-progress: #606060;");
    expect(lightBlock).toContain("--color-error: #dc2626;");
    expect(lightBlock).toContain("--cta-bg: #c05820;");
    expect(lightBlock).toContain("--cta-border: #d4622a;");
    expect(lightBlock).toContain("--color-info: #c05820;");
    expect(lightBlock).toContain("--accent: #d4622a;");

    expect(darkBlock).toContain("--color-warning: #f59e0b;");
    expect(lightBlock).toContain("--color-muted: #71717a;");
  });

  it("registers the default theme in core, dashboard options, and bootstrap validators", () => {
    expect(CORE_COLOR_THEMES).toContain("shadcn-ember");
    expect(DASHBOARD_COLOR_THEMES).toContainEqual({
      value: "shadcn-ember",
      label: "Shadcn Ember (Default)",
      className: "theme-swatch-shadcn-ember",
    });
    expect(DASHBOARD_COLOR_THEMES.filter((theme) => theme.label.includes("(Default)")).map((theme) => theme.value)).toEqual([
      "shadcn-ember",
    ]);

    expect(dashboardIndex).toContain("'shadcn-ember'");
    expect(dashboardIndex).toContain("|| 'shadcn-ember'");
    expect(dashboardIndex).toContain("colorTheme = 'shadcn-ember'");
    expect(desktopIndex).toContain('"shadcn-ember"');
    expect(desktopIndex).toContain('|| "shadcn-ember"');
    expect(desktopIndex).toContain('colorTheme = "shadcn-ember"');
  });

  it("keeps dashboard and desktop bootstrap validators identical to the core color theme union", () => {
    expect(DASHBOARD_COLOR_THEMES.map((theme) => theme.value)).toEqual([...CORE_COLOR_THEMES]);
    expect(extractValidThemes(dashboardIndex)).toEqual([...CORE_COLOR_THEMES]);
    expect(extractValidThemes(desktopIndex)).toEqual([...CORE_COLOR_THEMES]);
  });
});

function extractValidThemes(html: string): string[] {
  const match = html.match(/var validThemes = \[([\s\S]*?)\];/);
  if (!match) {
    throw new Error("Could not find pre-hydration validThemes array");
  }

  return Array.from(match[1].matchAll(/["']([^"']+)["']/g), ([, theme]) => theme);
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
