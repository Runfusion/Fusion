import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";

function extractMediaBlock(css: string, query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) {
    throw new Error(`Missing media query: ${query}`);
  }
  const open = css.indexOf("{", start);
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") depth -= 1;
    i += 1;
  }
  return css.slice(open + 1, i - 1);
}

describe("FileBrowser mobile dropdown regression", () => {
  it("keeps mobile file-browser header overflow unclipped", () => {
    const css = loadAllAppCss();
    const mobileBlock = extractMediaBlock(css, "(max-width: 768px)");
    const headerRuleMatch = mobileBlock.match(/\.file-browser-modal-header\s*\{[^}]*\}/);

    expect(headerRuleMatch?.[0]).toBeTruthy();
    expect(headerRuleMatch?.[0]).not.toMatch(/overflow\s*:\s*hidden/);
  });

  it("keeps workspace selector menu positioned above content", () => {
    const css = loadAllAppCss();
    const menuRuleMatch = css.match(/\.workspace-selector-menu\s*\{[^}]*\}/);

    expect(menuRuleMatch?.[0]).toMatch(/position\s*:\s*(absolute|fixed)\s*;/);
    const zIndexMatch = menuRuleMatch?.[0].match(/z-index\s*:\s*(\d+)/);
    expect(zIndexMatch).toBeTruthy();
    expect(Number(zIndexMatch?.[1])).toBeGreaterThanOrEqual(20);
  });
});
