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

  /*
   * FN-462 replaced the four-row phone header (`.file-browser-sort-controls { flex: 1 1 100% }` on its own line) with
   * a three-row compact header: path, search, then ONE un-wrapped actions row. The sort controls now share that row,
   * so the old full-width assertion described a layout that was itself half of the reported symptom.
   */
  it("keeps the phone sort controls inside the single compact actions row", () => {
    const css = loadAllAppCss();
    const phoneControls = css.match(/html\[data-viewport-mode="mobile"\] \.file-browser \.file-browser-sort-controls\s*\{[^}]*\}/)?.[0];
    const phoneActions = css.match(/html\[data-viewport-mode="mobile"\] \.file-browser \.file-browser-header-actions\s*\{[^}]*\}/)?.[0];
    const phoneSelect = css.match(/html\[data-viewport-mode="mobile"\] \.file-browser \.file-browser-sort-select\s*\{[^}]*\}/)?.[0];

    expect(phoneActions).toMatch(/flex:\s*1 1 100%/);
    expect(phoneActions).toMatch(/flex-wrap:\s*nowrap/);
    expect(phoneControls).toMatch(/flex:\s*1 1 auto/);
    expect(phoneControls).toMatch(/width:\s*auto/);
    expect(phoneSelect).toMatch(/flex:\s*1 1 auto/);
    // Strip comments first: the deletion is explained in a comment that quotes the very declaration being ratcheted.
    const phoneCssWithoutComments = extractMediaBlocks(css, "(max-width: 768px)").join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(phoneCssWithoutComments).not.toMatch(/\.file-browser-sort-controls\s*\{[^}]*flex:\s*1 1 100%/);
  });

  it("gives narrow modal sort controls a flexible token-based row", () => {
    const css = loadAllAppCss();
    expect(css).toMatch(/\.file-browser-modal--narrow \.file-browser-sort-controls\s*\{[^}]*flex:\s*1 1 calc\(var\(--space-xl\) \* 5\)/);
    expect(css).toMatch(/\.file-browser-modal--narrow \.file-browser-sort-select\s*\{[^}]*flex:\s*1 1 auto/);
  });

  it("wraps the file header against the dock tree width in both desktop layouts", () => {
    const css = loadAllAppCss();
    const headerRule = css.match(/\.dock-files-view__tree \.file-browser \.file-browser-header\s*\{[^}]*\}/)?.[0];
    const actionsRule = css.match(/\.dock-files-view__tree \.file-browser \.file-browser-header-actions\s*\{[^}]*\}/)?.[0];
    const controlsRule = css.match(/\.dock-files-view__tree \.file-browser-sort-controls\s*\{[^}]*\}/)?.[0];
    const selectRule = css.match(/\.dock-files-view__tree \.file-browser-sort-select\s*\{[^}]*\}/)?.[0];

    expect(headerRule).toMatch(/flex-wrap:\s*wrap/);
    expect(actionsRule).toMatch(/width:\s*100%/);
    expect(actionsRule).toMatch(/margin-left:\s*0/);
    expect(controlsRule).toMatch(/flex:\s*1 1 calc\(var\(--space-xl\) \* 5\)/);
    expect(selectRule).toMatch(/flex:\s*1 1 auto/);
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
