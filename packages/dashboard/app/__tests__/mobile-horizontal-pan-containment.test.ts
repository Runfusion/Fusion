import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

function extractMediaBlocks(content: string, pattern: RegExp): string {
  const blocks: string[] = [];

  for (const match of content.matchAll(pattern)) {
    const start = match.index! + match[0].length;
    let index = start;
    let depth = 1;
    while (index < content.length && depth > 0) {
      if (content[index] === "{") depth++;
      if (content[index] === "}") depth--;
      index++;
    }
    expect(depth).toBe(0);
    blocks.push(content.slice(start, index - 1));
  }

  expect(blocks.length).toBeGreaterThan(0);
  return blocks.join("\n");
}

function ruleBlock(css: string, selector: string): string {
  const blocks = ruleBlocks(css, selector);
  expect(blocks.length, `missing CSS rule for ${selector}`).toBeGreaterThan(0);
  return blocks[0];
}

function ruleBlocks(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{[^}]*\\}`, "gs"))].map((match) => match[0]);
}

function declarationValue(rule: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = rule.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`));
  return match?.[1]?.trim() ?? null;
}

describe("mobile horizontal pan containment (FN-6365)", () => {
  const css = loadAllAppCss();
  const mobileCss = extractMediaBlocks(css, /@media\s*\([^)]*max-width:\s*768px[^)]*\)[^{]*\{/g);
  const tabletCss = extractMediaBlocks(css, /@media\s*\(\s*min-width:\s*769px\s*\)\s*and\s*\(\s*max-width:\s*1024px\s*\)\s*\{/g);

  it("locks the document root against horizontal page panning on mobile", () => {
    const rootBlock = ruleBlock(mobileCss, "html,\n  body");
    const appRootBlock = ruleBlock(mobileCss, "#root");
    const starBlocks = ruleBlocks(mobileCss, "*");
    const defaultTouchBlock = starBlocks.find((block) => block.includes("touch-action: pan-y;")) ?? "";
    const widthContainmentBlock = starBlocks.find((block) => block.includes("max-inline-size: 100%;")) ?? "";

    expect(rootBlock).toContain("overflow-x: hidden;");
    expect(rootBlock).toContain("overscroll-behavior-x: none;");
    expect(rootBlock).toContain("touch-action: pan-y;");
    expect(rootBlock).toContain("width: 100%;");
    expect(rootBlock).toContain("max-width: 100%;");

    expect(appRootBlock).toContain("overflow-x: hidden;");
    expect(appRootBlock).toContain("overscroll-behavior-x: none;");
    expect(appRootBlock).toContain("touch-action: pan-y;");
    expect(appRootBlock).toContain("min-width: 0;");

    expect(declarationValue(defaultTouchBlock, "touch-action")).toBe("pan-y");
    expect(widthContainmentBlock).toContain("max-width: 100%;");
    expect(widthContainmentBlock).toContain("max-inline-size: 100%;");
  });

  it("preserves intentional horizontal scrolling for the mobile board and other opt-in scrollers", () => {
    const boardBlock = ruleBlock(mobileCss, ".board");
    const codeBlock = ruleBlock(mobileCss, "pre,\n  code,\n  .code-block");
    const tableBlock = ruleBlock(mobileCss, "table");

    expect(boardBlock).toContain("overflow-x: auto;");
    expect(boardBlock).toContain("scroll-snap-type: x proximity;");
    expect(boardBlock).toContain("-webkit-overflow-scrolling: touch;");
    expect(boardBlock).toContain("overscroll-behavior-x: contain;");
    expect(boardBlock).toContain("touch-action: pan-x pan-y;");
    expect(boardBlock).toContain("max-inline-size: 100%;");

    expect(codeBlock).toContain("overflow-x: auto;");
    expect(codeBlock).toContain("touch-action: pan-x pan-y;");
    expect(tableBlock).toContain("overflow-x: auto;");
    expect(tableBlock).toContain("touch-action: pan-x pan-y;");
  });

  it("constrains mobile fullscreen overlays to the viewport inline size", () => {
    const overlayBlock = ruleBlock(
      mobileCss,
      ".modal-overlay:not(.confirm-dialog-overlay),\n  .agent-dialog-overlay,\n  .workflow-output-modal-overlay",
    );
    const modalBlock = ruleBlock(
      mobileCss,
      ".modal:not(.confirm-dialog),\n  .modal-lg,\n  .modal-md,\n  .gm-modal",
    );

    expect(overlayBlock).toContain("inline-size: 100%;");
    expect(overlayBlock).toContain("max-inline-size: 100%;");
    expect(overlayBlock).toContain("overflow-x: hidden;");
    expect(overlayBlock).toContain("overscroll-behavior-x: none;");
    expect(overlayBlock).toContain("touch-action: pan-y;");

    expect(modalBlock).toContain("inline-size: 100%;");
    expect(modalBlock).toContain("max-inline-size: 100%;");
    expect(modalBlock).toContain("min-width: 0;");
    expect(modalBlock).toContain("height: 100dvh;");
  });

  it("leaves the tablet board horizontal overflow rule intact", () => {
    const boardBlock = ruleBlock(tabletCss, ".board");

    expect(boardBlock).toContain("grid-template-columns: repeat(6, minmax(260px, 1fr));");
    expect(boardBlock).toContain("overflow-x: auto;");
    expect(boardBlock).not.toContain("touch-action: pan-y;");
  });
});
