import { describe, expect, it } from "vitest";
import { COLOR_THEMES as CORE_COLOR_THEMES } from "@fusion/core";
import { COLOR_THEMES as DASHBOARD_COLOR_THEMES } from "../components/themeOptions";
import fs from "fs";
import path from "path";

const themeDataPath = path.resolve(__dirname, "../public/theme-data.css");
const dashboardIndexPath = path.resolve(__dirname, "../index.html");

/*
FNXC:DashboardTheming 2026-06-20-00:00:
Shadcn Gray is a zinc-only accent variant. This test locks the dashboard wiring and neutral token intent without asserting the desktop bootstrap validator, which intentionally excludes all shadcn variants.
*/
describe("Shadcn Gray color theme", () => {
  const themeData = fs.readFileSync(themeDataPath, "utf-8");

  it("defines dark and light neutral-gray shadcn token blocks", () => {
    const darkBlock = extractSelectorBlock(themeData, '[data-color-theme="shadcn-gray"]');
    const lightBlock = extractSelectorBlock(themeData, '[data-color-theme="shadcn-gray"][data-theme="light"]');

    expect(darkBlock).toContain("--surface-hover:");
    expect(lightBlock).toContain("--surface-hover:");
    expect(darkBlock).toContain("--btn-border-width: 1px;");
    expect(lightBlock).toContain("--cta-glow: none;");
    expect(darkBlock).toContain("--accent: #a1a1aa;");
    expect(lightBlock).toContain("--accent: #52525b;");
    expect(darkBlock).toContain("--color-info: #a1a1aa;");
    expect(lightBlock).toContain("--color-info: #52525b;");
    expect(`${darkBlock}\n${lightBlock}`).not.toContain("#ef4444");
    expect(`${darkBlock}\n${lightBlock}`).not.toContain("#3b82f6");
    expect(`${darkBlock}\n${lightBlock}`).not.toContain("#60a5fa");
  });

  it("hides header and modal title divider lines for seamless shadcn shells", () => {
    const dividerBlock = extractGroupedRuleBlock(themeData, '[data-color-theme^="shadcn"] .view-header');

    expect(dividerBlock).toContain('[data-color-theme^="shadcn"] .header');
    expect(dividerBlock).toContain('[data-color-theme^="shadcn"] .modal-header');
    expect(dividerBlock).toContain('[data-color-theme^="shadcn"] .floating-window-header');
    expect(dividerBlock).toContain("border-top-color: transparent;");
    expect(dividerBlock).toContain("border-bottom-color: transparent;");
    expect(dividerBlock).not.toContain("border-right-color");
    expect(dividerBlock).not.toContain("border-left-color");
  });

  it("registers Shadcn Gray in core, dashboard options, and the dashboard bootstrap validator", () => {
    expect(CORE_COLOR_THEMES).toContain("shadcn-gray");
    expect(DASHBOARD_COLOR_THEMES).toContainEqual({
      value: "shadcn-gray",
      label: "Shadcn Gray",
      className: "theme-swatch-shadcn-gray",
    });

    expect(fs.readFileSync(dashboardIndexPath, "utf-8")).toContain("'shadcn-gray'");
  });
});

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
