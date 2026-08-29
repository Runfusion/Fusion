import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";

function extractMediaBlocks(css: string, query: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    const start = css.indexOf(`@media ${query}`, cursor);
    if (start < 0) break;
    const open = css.indexOf("{", start);
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    blocks.push(css.slice(open + 1, i - 1));
    cursor = i;
  }
  return blocks;
}

describe("FileBrowser mobile dropdown regression", () => {
  it("FN-4480: collapsed editor toolbar region is hidden via display: none", async () => {
    const css = await loadAllAppCssBaseOnly();

    // The "collapsible" sub-element was renamed to "actions" when the toolbar
    // was reorganized; the hidden-collapse rule still lives on the new class.
    expect(css).toMatch(/\.file-editor-toolbar-actions\[hidden\]\s*\{[^}]*display:\s*none;[^}]*\}/);
  });

  it("keeps mobile file-browser header overflow unclipped", () => {
    const css = loadAllAppCss();
    const mobileBlocks = extractMediaBlocks(css, "(max-width: 768px)");
    const headerRule = mobileBlocks
      .map((block) => block.match(/\.file-browser-modal-header\s*\{[^}]*\}/)?.[0])
      .find(Boolean);

    expect(headerRule).toBeTruthy();
    expect(headerRule).not.toMatch(/overflow\s*:\s*hidden/);
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
