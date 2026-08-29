import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";

function extractMediaBlocks(css: string, query: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    const start = css.indexOf("@media", cursor);
    if (start < 0) break;
    const open = css.indexOf("{", start);
    if (open < 0) break;
    const mediaQuery = css.slice(start + "@media".length, open).trim();
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    if (mediaQuery.includes(query)) {
      blocks.push(css.slice(open + 1, i - 1));
    }
    cursor = i;
  }
  return blocks;
}

function findRule(css: string, selector: string): string | undefined {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`))?.[0];
}

describe("ArtifactsGallery mobile FloatingWindow sheet contract", () => {
  it("FN-7865: makes artifact viewer windows full-screen sheets on mobile", () => {
    const css = loadAllAppCss();
    const mobileCss = extractMediaBlocks(css, "(max-width: 768px)").join("\n");
    const windowRule = findRule(mobileCss, ".artifacts-gallery-window");
    const resizeHandleRule = findRule(mobileCss, ".artifacts-gallery-window .floating-window__resize-handle");
    const headerRule = findRule(mobileCss, ".artifacts-gallery-window .artifacts-gallery-viewer-header,\n  .artifacts-gallery-window .artifacts-gallery-viewer-header:active");

    expect(windowRule).toBeTruthy();
    expect(windowRule).toMatch(/inset:\s*0\s*!important;/);
    expect(windowRule).toMatch(/width:\s*100vw\s*!important;/);
    expect(windowRule).toMatch(/height:\s*100dvh\s*!important;/);

    expect(resizeHandleRule).toBeTruthy();
    expect(resizeHandleRule).toMatch(/display:\s*none;/);

    expect(headerRule).toBeTruthy();
    expect(headerRule).toMatch(/cursor:\s*default;/);
    expect(headerRule).toMatch(/touch-action:\s*auto;/);
    expect(headerRule).not.toMatch(/cursor:\s*grab(?:bing)?/);
    expect(headerRule).not.toMatch(/touch-action:\s*none/);
  });

  it("preserves the desktop header drag affordance outside mobile media queries", () => {
    const css = loadAllAppCssBaseOnly();
    const headerRule = findRule(css, ".artifacts-gallery-viewer-header");

    expect(headerRule).toBeTruthy();
    expect(headerRule).toMatch(/cursor:\s*grab;/);
  });
});
