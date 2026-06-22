import { describe, expect, it } from "vitest";
import { COLOR_THEMES as CORE_COLOR_THEMES } from "@fusion/core";
import { COLOR_THEMES as DASHBOARD_COLOR_THEMES } from "../components/themeOptions";
import fs from "fs";
import path from "path";

const themeDataPath = path.resolve(__dirname, "../public/theme-data.css");
const dashboardIndexPath = path.resolve(__dirname, "../index.html");
const desktopIndexPath = path.resolve(__dirname, "../../../desktop/src/renderer/index.html");

describe("Air color theme", () => {
  const themeData = fs.readFileSync(themeDataPath, "utf-8");

  it("defines dark and light Air theme blocks with clean font and faint borders", () => {
    const darkBlock = extractSelectorBlock(themeData, '[data-color-theme="air"]');
    const lightBlock = extractSelectorBlock(themeData, '[data-color-theme="air"][data-theme="light"]');

    expect(darkBlock).toContain('--font-primary: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif');
    expect(lightBlock).toContain('--font-primary: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif');
    expect(darkBlock).toContain("--border: color-mix(in srgb, var(--text) 8%, transparent)");
    expect(lightBlock).toContain("--border: color-mix(in srgb, var(--text) 8%, transparent)");
    expect(`${darkBlock}\n${lightBlock}`).not.toMatch(/rgba\(/);
    expect(`${darkBlock}\n${lightBlock}`).not.toMatch(/#[0-9a-fA-F]{8}\b/);
  });

  it("hides horizontal header and modal dividers while leaving vertical dividers themeable", () => {
    const dividerBlock = extractGroupedRuleBlock(themeData, '[data-color-theme="air"] .view-header');

    expect(dividerBlock).toContain('[data-color-theme="air"] .header');
    expect(dividerBlock).toContain('[data-color-theme="air"] .modal-header');
    expect(dividerBlock).toContain('[data-color-theme="air"] .floating-window-header');
    expect(dividerBlock).toContain("border-top-color: transparent;");
    expect(dividerBlock).toContain("border-bottom-color: transparent;");
    expect(dividerBlock).not.toContain("border-right-color");
    expect(dividerBlock).not.toContain("border-left-color");
  });

  it("registers Air in core, dashboard options, and both bootstrap validators", () => {
    expect(CORE_COLOR_THEMES).toContain("air");
    expect(DASHBOARD_COLOR_THEMES).toContainEqual({
      value: "air",
      label: "Air",
      className: "theme-swatch-air",
    });

    expect(fs.readFileSync(dashboardIndexPath, "utf-8")).toContain("'air'");
    expect(fs.readFileSync(desktopIndexPath, "utf-8")).toContain('"air"');
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
