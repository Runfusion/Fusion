import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS_DIR = resolve(__dirname, "..");

function readComponentCss(fileName: string): string {
  return readFileSync(join(COMPONENTS_DIR, fileName), "utf-8");
}

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

function findRule(blocks: string[], selector: RegExp): string {
  const globalSelector = new RegExp(selector.source, selector.flags.includes("g") ? selector.flags : `${selector.flags}g`);
  const matches = blocks.flatMap((block) => [...block.matchAll(globalSelector)].map((match) => match[0]));
  const rule = matches.at(-1) ?? "";
  expect(rule).toBeTruthy();
  return rule;
}

describe("MobileWorkflowGraphView CSS contract", () => {
  it("adds interactive states to simple editor graph buttons", () => {
    const graphCss = readComponentCss("MobileWorkflowGraphView.css");

    const nodeMainHoverRule = findRule([graphCss], /\.mobile-wf-node-main:hover\s*\{[^}]*\}/);
    expect(nodeMainHoverRule).toMatch(/background\s*:\s*var\(--bg-tertiary\)\s*;/);
    const nodeMainFocusRule = findRule([graphCss], /\.mobile-wf-node-main:focus-visible\s*\{[^}]*\}/);
    expect(nodeMainFocusRule).toMatch(/box-shadow\s*:\s*var\(--focus-ring-strong\)\s*;/);
    const nodeMainActiveRule = findRule([graphCss], /\.mobile-wf-node-main:active\s*\{[^}]*\}/);
    expect(nodeMainActiveRule).toMatch(/transform\s*:\s*scale\(0\.97\)\s*;/);

    const nodeExpandHoverRule = findRule([graphCss], /\.mobile-wf-node-expand:hover,\s*\.mobile-wf-node-move:not\(:disabled\):hover,\s*\.mobile-wf-connect-button:hover\s*\{[^}]*\}/);
    expect(nodeExpandHoverRule).toMatch(/background\s*:\s*var\(--bg-tertiary\)\s*;/);
    const nodeExpandFocusRule = findRule([graphCss], /\.mobile-wf-node-expand:focus-visible,\s*\.mobile-wf-node-move:focus-visible,\s*\.mobile-wf-connect-button:focus-visible,\s*\.mobile-wf-connect-select:focus-visible\s*\{[^}]*\}/);
    expect(nodeExpandFocusRule).toMatch(/box-shadow\s*:\s*var\(--focus-ring-strong\)\s*;/);
    const nodeExpandActiveRule = findRule([graphCss], /\.mobile-wf-node-expand:active,\s*\.mobile-wf-node-move:not\(:disabled\):active,\s*\.mobile-wf-connect-button:active\s*\{[^}]*\}/);
    expect(nodeExpandActiveRule).toMatch(/transform\s*:\s*scale\(0\.97\)\s*;/);
    const nodeMoveSizeRule = findRule([graphCss], /\.mobile-wf-node-expand,\s*\.mobile-wf-node-move\s*\{[^}]*\}/);
    expect(nodeMoveSizeRule).toMatch(/width\s*:\s*var\(--wf-editor-touch-target\)\s*;/);

    const edgeChipHoverRule = findRule([graphCss], /\.mobile-wf-edge-chip:hover\s*\{[^}]*\}/);
    expect(edgeChipHoverRule).toMatch(/background\s*:\s*var\(--bg-secondary\)\s*;/);
    const edgeChipFocusRule = findRule([graphCss], /\.mobile-wf-edge-chip:focus-visible\s*\{[^}]*\}/);
    expect(edgeChipFocusRule).toMatch(/box-shadow\s*:\s*var\(--focus-ring-strong\)\s*;/);
    const edgeChipActiveRule = findRule([graphCss], /\.mobile-wf-edge-chip:active\s*\{[^}]*\}/);
    expect(edgeChipActiveRule).toMatch(/transform\s*:\s*scale\(0\.97\)\s*;/);
  });

  it("uses spacing tokens for edge chip gaps", () => {
    const graphCss = readComponentCss("MobileWorkflowGraphView.css");

    expect(graphCss).not.toMatch(/gap\s*:\s*4px\s*;/);
    const edgeChipRule = findRule([graphCss], /\.mobile-wf-column-chip,\s*\.mobile-wf-edge-chip\s*\{[^}]*\}/);
    expect(edgeChipRule).toMatch(/gap\s*:\s*var\(--space-xs\)\s*;/);
  });
});

describe("WorkflowNodeEditor simple editor mobile CSS contract", () => {
  it("adds interactive states to mobile add and tab buttons", () => {
    const editorCss = readComponentCss("WorkflowNodeEditor.css");

    const tabHoverRule = findRule([editorCss], /\.wf-mobile-tab:hover\s*\{[^}]*\}/);
    expect(tabHoverRule).toMatch(/background\s*:\s*var\(--bg-tertiary\)\s*;/);

    const addHoverRule = findRule(
      [editorCss],
      /\.wf-mobile-add-option:hover,\s*\.wf-mobile-template-option:hover\s*\{[^}]*\}/,
    );
    expect(addHoverRule).toMatch(/background\s*:\s*var\(--bg-tertiary\)\s*;/);

    const addFocusRule = findRule(
      [editorCss],
      /\.wf-mobile-add-option:focus-visible,\s*\.wf-mobile-template-option:focus-visible\s*\{[^}]*\}/,
    );
    expect(addFocusRule).toMatch(/box-shadow\s*:\s*var\(--focus-ring-strong\)\s*;/);

    const addActiveRule = findRule(
      [editorCss],
      /\.wf-mobile-add-option:active,\s*\.wf-mobile-template-option:active\s*\{[^}]*\}/,
    );
    expect(addActiveRule).toMatch(/transform\s*:\s*scale\(0\.97\)\s*;/);
  });
});
