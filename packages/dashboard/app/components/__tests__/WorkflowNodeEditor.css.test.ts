import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAllAppCssBaseOnly } from "../../test/cssFixture";

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

function expectNoHardcodedWhiteBackground(rule: string): void {
  expect(rule).not.toMatch(/background(?:-color)?\s*:[^;]*(?:#fff|#ffffff|\bwhite\b)/i);
}

describe("WorkflowNodeEditor themed React Flow CSS contract", () => {
  it("matches the shared Insights/ViewHeader chrome", () => {
    const editorCss = readComponentCss("WorkflowNodeEditor.css");
    const headerRule = findRule([editorCss], /\.wf-editor-header\s*\{[^}]*\}/);
    const titleRule = findRule([editorCss], /\.wf-editor-header h2\s*\{[^}]*\}/);
    const iconRule = findRule([editorCss], /\.wf-editor-header h2 svg\s*\{[^}]*\}/);

    expect(headerRule).toMatch(/min-height\s*:\s*var\(--view-header-min-height\)\s*;/);
    expect(headerRule).toMatch(/padding\s*:\s*var\(--space-lg\) var\(--space-xl\)\s*;/);
    expect(headerRule).toMatch(/background\s*:\s*var\(--surface\)\s*;/);
    // FNXC:WorkflowEditorFloatingModal 2026-06-25-19:06: FloatingWindow owns the modal frame; the embedded editor header keeps shared ViewHeader sizing but no inner divider so the floating shell does not render double chrome.
    expect(headerRule).toMatch(/border-bottom\s*:\s*none\s*;/);
    expect(titleRule).toMatch(/font-size\s*:\s*1\.125rem\s*;/);
    expect(titleRule).toMatch(/font-weight\s*:\s*600\s*;/);
    expect(iconRule).toMatch(/color\s*:\s*var\(--todo\)\s*;/);
  });

  it("FN-6701 themes zoom controls, mini-map, and sidebar checkboxes with tokens", () => {
    const baseCss = loadAllAppCssBaseOnly();

    // Surface Enumeration: WorkflowNodeEditor.tsx is the only React Flow <Controls /> / <MiniMap pannable zoomable /> mount; WorkflowResultsTab and MobileWorkflowGraphView do not mount those affordances. Left-sidebar checkbox surfaces are WorkflowSettingsPanel, WorkflowFieldsPanel, and WorkflowColumnPanel trait toggles; inspector .wf-field--checkbox stays covered by WorkflowNodeEditor.css.
    const controlsRule = findRule([baseCss], /\.wf-editor-canvas \.react-flow__controls\s*\{[^}]*\}/);
    expect(controlsRule).toMatch(/background\s*:\s*var\(--surface\)\s*;/);
    expect(controlsRule).toMatch(/border\s*:\s*var\(--btn-border-width\) solid var\(--border\)\s*;/);
    expect(controlsRule).toMatch(/color\s*:\s*var\(--text\)\s*;/);
    expectNoHardcodedWhiteBackground(controlsRule);

    const controlsButtonRule = findRule([baseCss], /\.wf-editor-canvas \.react-flow__controls-button\s*\{[^}]*\}/);
    expect(controlsButtonRule).toMatch(/background\s*:\s*var\(--surface\)\s*;/);
    expect(controlsButtonRule).toMatch(/border-bottom\s*:\s*var\(--btn-border-width\) solid var\(--border\)\s*;/);
    expect(controlsButtonRule).toMatch(/color\s*:\s*var\(--text\)\s*;/);
    expect(controlsButtonRule).toMatch(/fill\s*:\s*currentColor\s*;/);
    expectNoHardcodedWhiteBackground(controlsButtonRule);

    const controlsButtonHoverRule = findRule(
      [baseCss],
      /\.wf-editor-canvas \.react-flow__controls-button:hover\s*\{[^}]*\}/,
    );
    expect(controlsButtonHoverRule).toMatch(/background\s*:\s*var\(--surface-hover\)\s*;/);
    expect(controlsButtonHoverRule).toMatch(/color\s*:\s*var\(--text\)\s*;/);
    expectNoHardcodedWhiteBackground(controlsButtonHoverRule);

    const controlsSvgRule = findRule([baseCss], /\.wf-editor-canvas \.react-flow__controls-button svg\s*\{[^}]*\}/);
    expect(controlsSvgRule).toMatch(/fill\s*:\s*currentColor\s*;/);
    expect(controlsSvgRule).toMatch(/stroke\s*:\s*currentColor\s*;/);

    const minimapRule = findRule([baseCss], /\.wf-editor-canvas \.react-flow__minimap\s*\{[^}]*\}/);
    expect(minimapRule).toMatch(/background\s*:\s*var\(--surface\)\s*;/);
    expect(minimapRule).toMatch(/border\s*:\s*var\(--btn-border-width\) solid var\(--border\)\s*;/);
    expectNoHardcodedWhiteBackground(minimapRule);

    const minimapNodeRule = findRule([baseCss], /\.wf-editor-canvas \.react-flow__minimap-node\s*\{[^}]*\}/);
    expect(minimapNodeRule).not.toMatch(/\bfill\s*:/);
    expect(minimapNodeRule).toMatch(/stroke\s*:\s*var\(--border-strong, var\(--border\)\)\s*;/);

    const minimapMaskRule = findRule([baseCss], /\.wf-editor-canvas \.react-flow__minimap-mask\s*\{[^}]*\}/);
    expect(minimapMaskRule).toMatch(/fill\s*:\s*color-mix\(in srgb, var\(--surface\) 70%, transparent\)\s*;/);

    const minimapToggleRule = findRule([baseCss], /\.wf-minimap-toggle\s*\{[^}]*\}/);
    expect(minimapToggleRule).toMatch(/position\s*:\s*absolute\s*;/);
    expect(minimapToggleRule).toMatch(/background\s*:\s*var\(--surface\)\s*;/);
    expect(minimapToggleRule).toMatch(/border\s*:\s*var\(--btn-border-width\) solid var\(--border\)\s*;/);
    expectNoHardcodedWhiteBackground(minimapToggleRule);

    for (const selector of [
      /\.wf-setting--checkbox input\[type="checkbox"\]\s*\{[^}]*\}/,
      /\.wf-field--checkbox input\[type="checkbox"\]\s*\{[^}]*\}/,
      /\.wf-column-trait input\[type="checkbox"\]\s*\{[^}]*\}/,
      /\.wf-column-agent-mode-option input\[type="radio"\]\s*\{[^}]*\}/,
    ]) {
      const checkboxRule = findRule([baseCss], selector);
      expect(checkboxRule).toMatch(/accent-color\s*:\s*var\(--todo\)\s*;/);
      expectNoHardcodedWhiteBackground(checkboxRule);
    }

    const lightThemeOverrides = [...baseCss.matchAll(/\[data-theme="light"\][^{]*\{[^}]*\}/g)].map((match) => match[0]);
    for (const overrideRule of lightThemeOverrides.filter((rule) => /react-flow__|wf-(?:setting|field|column-trait)/.test(rule))) {
      expect(overrideRule).toMatch(/var\(--/);
      expectNoHardcodedWhiteBackground(overrideRule);
    }
  });
});

describe("WorkflowNodeEditor edge visibility CSS contract", () => {
  it("keeps swimlane bands translucent so built-in workflow edges remain visible", () => {
    const editorCss = readComponentCss("WorkflowNodeEditor.css");
    const columnBandRule = findRule([editorCss], /\.wf-column-band\s*\{[^}]*\}/);
    expect(columnBandRule).toMatch(/background\s*:\s*color-mix\(in srgb, var\(--bg-secondary\) 65%, transparent\)\s*;/);
    expect(columnBandRule).toMatch(/pointer-events\s*:\s*none\s*;/);

    const reworkRule = findRule([editorCss], /\.wf-edge-rework \.react-flow__edge-path\s*\{[^}]*\}/);
    expect(reworkRule).toMatch(/stroke\s*:\s*var\(--accent, var\(--ws-info\)\)\s*;/);
    expect(reworkRule).toMatch(/stroke-dasharray\s*:\s*5 4\s*;/);

    const failureRule = findRule([editorCss], /\.react-flow__edge\.wf-edge-failure \.react-flow__edge-path\s*\{[^}]*\}/);
    expect(failureRule).toMatch(/stroke\s*:\s*var\(--ws-error\)\s*;/);
    expect(failureRule).toMatch(/stroke-dasharray\s*:\s*2 4\s*;/);
  });
});

describe("WorkflowNodeEditor sidebar overflow CSS contract", () => {
  it("FN-6379 clamps horizontal overflow on desktop and list-stage sidebars", () => {
    const editorCss = readComponentCss("WorkflowNodeEditor.css");
    const mobileBlocks = extractMediaBlocks(editorCss, "(max-width: 768px)");

    const desktopSidebarRule = findRule([editorCss], /\.wf-editor-sidebar\s*\{(?=[^}]*width\s*:\s*300px)[^}]*\}/);
    expect(desktopSidebarRule).toMatch(/width\s*:\s*300px\s*;/);
    expect(desktopSidebarRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(desktopSidebarRule).toMatch(/overflow-x\s*:\s*hidden\s*;/);
    expect(desktopSidebarRule).toMatch(/overflow-y\s*:\s*auto\s*;/);

    const listStageSidebarRule = findRule(mobileBlocks, /\.wf-editor-body--list-stage \.wf-editor-sidebar\s*\{[^}]*\}/);
    expect(listStageSidebarRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(listStageSidebarRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(listStageSidebarRule).toMatch(/overflow-x\s*:\s*hidden\s*;/);
    expect(listStageSidebarRule).toMatch(/overflow-y\s*:\s*auto\s*;/);

    const collapsedSidebarRule = findRule([editorCss], /\.wf-editor-body--sidebar-collapsed \.wf-editor-sidebar\s*\{[^}]*\}/);
    expect(collapsedSidebarRule).toMatch(/display\s*:\s*none\s*;/);

    const restoreRule = findRule([editorCss], /\.wf-sidebar-shell-restore\s*\{[^}]*\}/);
    expect(restoreRule).not.toMatch(/position\s*:\s*absolute\s*;/);
    expect(restoreRule).toMatch(/flex\s*:\s*0 0 auto\s*;/);
    expect(restoreRule).toMatch(/width\s*:\s*30px\s*;/);
    expect(restoreRule).toMatch(/padding-inline\s*:\s*0\s*;/);
    expect(restoreRule).toMatch(/white-space\s*:\s*nowrap\s*;/);
  });

  it("FN-6379 keeps sidebar children from forcing horizontal scroll", () => {
    const editorCss = readComponentCss("WorkflowNodeEditor.css");

    const listRule = findRule([editorCss], /\.wf-editor-list\s*\{[^}]*\}/);
    expect(listRule).toMatch(/min-width\s*:\s*0\s*;/);

    const listItemRule = findRule([editorCss], /\.wf-editor-list-item\s*\{[^}]*\}/);
    expect(listItemRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(listItemRule).toMatch(/overflow\s*:\s*hidden\s*;/);
    expect(listItemRule).toMatch(/text-overflow\s*:\s*ellipsis\s*;/);
    expect(listItemRule).toMatch(/white-space\s*:\s*nowrap\s*;/);

    const paletteRule = findRule([editorCss], /\.wf-editor-palette\s*\{[^}]*\}/);
    expect(paletteRule).toMatch(/min-width\s*:\s*0\s*;/);

    const paletteButtonRule = findRule(
      [editorCss],
      /\.wf-palette-btn,\s*\.wf-editor-action,\s*\.wf-editor-delete,\s*\.wf-editor-save\s*\{[^}]*\}/,
    );
    expect(paletteButtonRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(paletteButtonRule).toMatch(/overflow-wrap\s*:\s*anywhere\s*;/);

    const actionNoWrapRule = findRule(
      [editorCss],
      /\.wf-editor-toolbar \.wf-editor-action,\s*\.wf-editor-toolbar \.wf-editor-delete,\s*\.wf-editor-toolbar \.wf-editor-save,\s*\.wf-editor-readonly-banner \.wf-editor-action,\s*\.wf-editor-readonly-banner \.wf-editor-save\s*\{[^}]*\}/,
    );
    expect(actionNoWrapRule).toMatch(/white-space\s*:\s*nowrap\s*;/);
    expect(actionNoWrapRule).toMatch(/overflow-wrap\s*:\s*normal\s*;/);

    const sidebarCodeRule = findRule([editorCss], /\.wf-editor-sidebar \.wf-code-source\s*\{[^}]*\}/);
    expect(sidebarCodeRule).toMatch(/overflow-x\s*:\s*hidden\s*;/);
    expect(sidebarCodeRule).toMatch(/overflow-wrap\s*:\s*anywhere\s*;/);
    expect(sidebarCodeRule).toMatch(/white-space\s*:\s*pre-wrap\s*;/);
  });
});

describe("WorkflowNodeEditor mobile CSS contract", () => {
  it("FN-7827 keeps workflow editor shell unclamped across floating, embedded, and mobile hosts", () => {
    const baseCss = loadAllAppCssBaseOnly();
    const editorCss = readComponentCss("WorkflowNodeEditor.css");
    const mobileBlocks = extractMediaBlocks(editorCss, "(max-width: 768px)");

    // FNXC:WorkflowEditorFloatingModal 2026-07-11-00:00: Surface Enumeration for FN-7827 covers the desktop FloatingWindow base shell, embedded main-content pane, and mobile full-screen sheet so the fix encodes the invariant instead of only the reported 80vh repro.
    const desktopModalRule = findRule([baseCss], /\.wf-editor-modal\s*\{[^}]*\}/);
    expect(desktopModalRule).toMatch(/max-height\s*:\s*none\s*;/);
    expect(desktopModalRule).toMatch(/max-width\s*:\s*none\s*;/);
    expect(desktopModalRule).not.toMatch(/max-height\s*:\s*80vh\s*;/);

    const embeddedModalRule = findRule([baseCss], /\.wf-editor-modal--embedded\s*\{[^}]*\}/);
    expect(embeddedModalRule).toMatch(/max-height\s*:\s*none\s*;/);

    const mobileModalRule = findRule(
      mobileBlocks,
      /\.wf-editor-modal:not\(\.wf-editor-modal--embedded\),\s*\.wf-create-modal\s*\{[^}]*\}/,
    );
    expect(mobileModalRule).toMatch(/height\s*:\s*100dvh\s*;/);
    expect(mobileModalRule).toMatch(/max-height\s*:\s*100dvh\s*;/);
  });

  it("FN-5992 lets FloatingWindow own desktop minimum while keeping mobile overrides", () => {
    const editorCss = readComponentCss("WorkflowNodeEditor.css");
    const mobileBlocks = extractMediaBlocks(editorCss, "(max-width: 768px)");

    const desktopModalRule = findRule([editorCss], /\.wf-editor-modal\s*\{[^}]*\}/);
    // FNXC:WorkflowEditorFloatingModal 2026-06-25-19:06: Desktop minimum size moved from the inner .wf-editor-modal CSS to the FloatingWindow minSize contract so persisted resizes clamp at the shared shell instead of fighting nested min-width rules.
    expect(desktopModalRule).toMatch(/min-width\s*:\s*0\s*;/);

    // FN-6: the mobile viewport-takeover rule is scoped to the dialog presentation
    // via :not(.wf-editor-modal--embedded) so the embedded main-view variant keeps its
    // 100%-of-pane sizing. Match the scoped selector; .wf-create-modal has no embedded
    // variant and stays unscoped.
    const editorModalRule = findRule(
      mobileBlocks,
      /\.wf-editor-modal:not\(\.wf-editor-modal--embedded\),\s*\.wf-create-modal\s*\{[^}]*\}/,
    );
    expect(editorModalRule).toMatch(/width\s*:\s*100vw\s*;/);
    expect(editorModalRule).toMatch(/height\s*:\s*100dvh\s*;/);
    expect(editorModalRule).toMatch(/border-radius\s*:\s*0\s*;/);
    expect(editorModalRule).toMatch(/resize\s*:\s*none\s*;/);

    const sidebarRule = findRule(mobileBlocks, /\.wf-editor-body--list-stage \.wf-editor-sidebar\s*\{[^}]*\}/);
    expect(sidebarRule).toMatch(/width\s*:\s*100%\s*;/);

    const inspectorRule = findRule(mobileBlocks, /\.wf-editor-inspector\s*\{[^}]*\}/);
    expect(inspectorRule).toMatch(/width\s*:\s*100%\s*;/);

    const settingsRule = findRule(mobileBlocks, /\.wf-editor-body \.wf-settings-panel\s*\{[^}]*\}/);
    expect(settingsRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(settingsRule).toMatch(/min-width\s*:\s*0\s*;/);

    const canvasWrapRule = findRule(mobileBlocks, /\.wf-editor-canvas-wrap\s*\{[^}]*\}/);
    expect(canvasWrapRule).toMatch(/min-height\s*:\s*0\s*;/);
  });

  it("FN-6058 keeps mobile workflow editor controls from crowding the canvas", () => {
    const editorCss = readComponentCss("WorkflowNodeEditor.css");
    const mobileBlocks = extractMediaBlocks(editorCss, "(max-width: 768px)");

    const toolbarRule = findRule(mobileBlocks, /\.wf-editor-toolbar\s*\{[^}]*\}/);
    expect(toolbarRule).toMatch(/flex-wrap\s*:\s*nowrap\s*;/);
    expect(toolbarRule).toMatch(/overflow-x\s*:\s*auto\s*;/);

    const editorStageCanvasRule = findRule(mobileBlocks, /\.wf-editor-body--editor-stage \.wf-editor-canvas\s*\{[^}]*\}/);
    expect(editorStageCanvasRule).toMatch(/flex\s*:\s*1 1 auto\s*;/);
    expect(editorStageCanvasRule).toMatch(/min-height\s*:\s*0\s*;/);

    const inspectorRule = findRule(mobileBlocks, /\.wf-editor-body--editor-stage \.wf-editor-inspector\s*\{[^}]*\}/);
    expect(inspectorRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(inspectorRule).toMatch(/max-height\s*:\s*none\s*;/);
    expect(inspectorRule).toMatch(/flex\s*:\s*1 1 auto\s*;/);
    expect(inspectorRule).toMatch(/min-height\s*:\s*0\s*;/);

    const mobileDetailCanvasRule = findRule(mobileBlocks, /\.wf-editor-body--mobile-node-detail \.wf-editor-canvas-wrap\s*\{[^}]*\}/);
    expect(mobileDetailCanvasRule).toMatch(/display\s*:\s*none\s*;/);

    const mobileDetailInspectorRule = findRule(mobileBlocks, /\.wf-editor-body--mobile-node-detail \.wf-editor-inspector\s*\{[^}]*\}/);
    expect(mobileDetailInspectorRule).toMatch(/display\s*:\s*flex\s*;/);
    expect(mobileDetailInspectorRule).toMatch(/flex\s*:\s*1 1 auto\s*;/);
    expect(mobileDetailInspectorRule).toMatch(/min-height\s*:\s*0\s*;/);
    expect(mobileDetailInspectorRule).toMatch(/max-height\s*:\s*none\s*;/);

    const mobileEdgeDetailCanvasRule = findRule(mobileBlocks, /\.wf-editor-body--mobile-edge-detail \.wf-editor-canvas-wrap\s*\{[^}]*\}/);
    expect(mobileEdgeDetailCanvasRule).toMatch(/display\s*:\s*none\s*;/);

    const mobileEdgeDetailInspectorRule = findRule(mobileBlocks, /\.wf-editor-body--mobile-edge-detail \.wf-editor-inspector\s*\{[^}]*\}/);
    expect(mobileEdgeDetailInspectorRule).toMatch(/display\s*:\s*flex\s*;/);
    expect(mobileEdgeDetailInspectorRule).toMatch(/flex\s*:\s*1 1 auto\s*;/);
    expect(mobileEdgeDetailInspectorRule).toMatch(/max-height\s*:\s*none\s*;/);

    const mobileTabsRule = findRule([editorCss], /\.wf-mobile-tabs\s*\{[^}]*\}/);
    expect(mobileTabsRule).toMatch(/flex\s*:\s*0 0 auto\s*;/);

    const collapsedToggleRule = findRule([editorCss], /\.wf-inspector-toggle--collapsed\s*\{[^}]*\}/);
    expect(collapsedToggleRule).toMatch(/position\s*:\s*absolute\s*;/);
    expect(collapsedToggleRule).toMatch(/bottom\s*:\s*var\(--space-sm\)\s*;/);
  });

  it("FN-7236 keeps simple-editor tabs as the touch-pannable horizontal scroller", () => {
    const editorCss = readComponentCss("WorkflowNodeEditor.css");

    // Surface Enumeration: the same .wf-mobile-tabs/.wf-mobile-tab rules render for mobile automatic simple layout and desktop/tablet compact simple layout because they intentionally live outside the mobile media query.
    const tabsRule = findRule([editorCss], /\.wf-mobile-tabs\s*\{[^}]*\}/);
    expect(tabsRule).toMatch(/box-sizing\s*:\s*border-box\s*;/);
    expect(tabsRule).toMatch(/display\s*:\s*flex\s*;/);
    expect(tabsRule).toMatch(/flex\s*:\s*0 0 auto\s*;/);
    expect(tabsRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(tabsRule).toMatch(/inline-size\s*:\s*100%\s*;/);
    expect(tabsRule).toMatch(/max-width\s*:\s*100%\s*;/);
    expect(tabsRule).toMatch(/max-inline-size\s*:\s*100%\s*;/);
    expect(tabsRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(tabsRule).toMatch(/min-inline-size\s*:\s*0\s*;/);
    expect(tabsRule).toMatch(/overflow-x\s*:\s*auto\s*;/);
    expect(tabsRule).toMatch(/overflow-y\s*:\s*hidden\s*;/);
    expect(tabsRule).toMatch(/overscroll-behavior-inline\s*:\s*contain\s*;/);
    expect(tabsRule).toMatch(/touch-action\s*:\s*pan-x pan-y\s*;/);
    expect(tabsRule).toMatch(/-webkit-overflow-scrolling\s*:\s*touch\s*;/);

    const tabRule = findRule([editorCss], /\.wf-mobile-tab\s*\{[^}]*\}/);
    expect(tabRule).toMatch(/box-sizing\s*:\s*border-box\s*;/);
    expect(tabRule).toMatch(/flex\s*:\s*0 0 auto\s*;/);
    expect(tabRule).toMatch(/min-width\s*:\s*max-content\s*;/);
    expect(tabRule).toMatch(/white-space\s*:\s*nowrap\s*;/);
    expect(tabRule).toMatch(/touch-action\s*:\s*pan-x pan-y\s*;/);
    expect(tabRule).toMatch(/min-height\s*:\s*var\(--wf-editor-touch-target\)\s*;/);
  });

  it("FN-6034 keeps the desktop graph canvas shrinkable while FloatingWindow owns the modal minimum", () => {
    const baseCss = loadAllAppCssBaseOnly();

    const desktopModalRule = findRule([baseCss], /\.wf-editor-modal\s*\{[^}]*\}/);
    // FNXC:WorkflowEditorFloatingModal 2026-06-25-19:06: The inner editor remains shrinkable (min-width: 0); the non-embedded floating shell enforces the 640px minimum through WorkflowNodeEditor.tsx minSize.
    expect(desktopModalRule).toMatch(/min-width\s*:\s*0\s*;/);

    const bodyRule = findRule([baseCss], /\.wf-editor-body\s*\{[^}]*\}/);
    expect(bodyRule).toMatch(/min-width\s*:\s*0\s*;/);

    const canvasWrapRule = findRule([baseCss], /\.wf-editor-canvas-wrap\s*\{[^}]*\}/);
    expect(canvasWrapRule).toMatch(/min-width\s*:\s*0\s*;/);

    const canvasRule = findRule([baseCss], /\.wf-editor-canvas\s*\{[^}]*\}/);
    expect(canvasRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(canvasRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(canvasRule).toMatch(/overflow\s*:\s*hidden\s*;/);
  });

  it("FN-6034 makes the mobile React Flow surface fill the editor stage without horizontal overflow", () => {
    const editorCss = readComponentCss("WorkflowNodeEditor.css");
    const mobileBlocks = extractMediaBlocks(editorCss, "(max-width: 768px)");

    const editorBodyRule = findRule(mobileBlocks, /\.wf-editor-body\s*\{[^}]*\}/);
    expect(editorBodyRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(editorBodyRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(editorBodyRule).toMatch(/overflow-x\s*:\s*hidden\s*;/);

    const editorStageWrapRule = findRule(mobileBlocks, /\.wf-editor-body--editor-stage \.wf-editor-canvas-wrap\s*\{[^}]*\}/);
    expect(editorStageWrapRule).toMatch(/flex\s*:\s*0 1 auto\s*;/);
    expect(editorStageWrapRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(editorStageWrapRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(editorStageWrapRule).toMatch(/overflow\s*:\s*hidden\s*;/);

    const canvasRule = findRule(mobileBlocks, /\.wf-editor-canvas\s*\{[^}]*\}/);
    expect(canvasRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(canvasRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(canvasRule).toMatch(/max-width\s*:\s*100%\s*;/);
    expect(canvasRule).toMatch(/overflow\s*:\s*hidden\s*;/);

    const reactFlowSurfaceRule = findRule(
      mobileBlocks,
      /\.wf-editor-canvas \.react-flow,\s*\.wf-editor-canvas \.react-flow__renderer,\s*\.wf-editor-canvas \.react-flow__pane,\s*\.wf-editor-canvas \.react-flow__viewport\s*\{[^}]*\}/,
    );
    expect(reactFlowSurfaceRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(reactFlowSurfaceRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(reactFlowSurfaceRule).toMatch(/max-width\s*:\s*100%\s*;/);
    expect(reactFlowSurfaceRule).toMatch(/height\s*:\s*100%\s*;/);
  });

  it("FN-6034 preserves mobile staged editor visibility and inspector stacking", () => {
    const editorCss = readComponentCss("WorkflowNodeEditor.css");
    const mobileBlocks = extractMediaBlocks(editorCss, "(max-width: 768px)");

    const listStageHiddenRule = findRule(
      mobileBlocks,
      /\.wf-editor-body--list-stage \.wf-editor-canvas-wrap,\s*\.wf-editor-body--list-stage \.wf-editor-inspector\s*\{[^}]*\}/,
    );
    expect(listStageHiddenRule).toMatch(/display\s*:\s*none\s*;/);

    const editorStageSidebarRule = findRule(mobileBlocks, /\.wf-editor-body--editor-stage \.wf-editor-sidebar\s*\{[^}]*\}/);
    expect(editorStageSidebarRule).toMatch(/display\s*:\s*none\s*;/);

    const inspectorRule = findRule(mobileBlocks, /\.wf-editor-body--editor-stage \.wf-editor-inspector\s*\{[^}]*\}/);
    expect(inspectorRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(inspectorRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(inspectorRule).toMatch(/border-top\s*:\s*1px solid var\(--border\)\s*;/);
  });

  it("FN-6033 keeps workflow editor touch target increases mobile-scoped", () => {
    const baseCss = loadAllAppCssBaseOnly();
    const editorCss = readComponentCss("WorkflowNodeEditor.css");
    const mobileBlocks = extractMediaBlocks(editorCss, "(max-width: 768px)");

    const modalRule = findRule([baseCss], /\.wf-editor-modal\s*\{[^}]*\}/);
    expect(modalRule).toMatch(/--wf-editor-touch-target\s*:\s*calc\(var\(--space-xl\) \+ var\(--space-lg\) \+ var\(--space-xs\)\)\s*;/);

    const listAndActionRule = findRule(
      mobileBlocks,
      /\.wf-editor-list-item,\s*\.wf-editor-new,\s*\.wf-editor-import,[^}]*\.wf-settings-panel button\s*\{[^}]*\}/,
    );
    expect(listAndActionRule).toMatch(/min-height\s*:\s*var\(--wf-editor-touch-target\)\s*;/);

    const editorButtonsRule = findRule(
      mobileBlocks,
      /\.wf-editor-list-item,\s*\.wf-editor-new,\s*\.wf-editor-import,[^}]*\.wf-ai-toggle\s*\{[^}]*\}/,
    );
    expect(editorButtonsRule).toMatch(/padding\s*:\s*var\(--space-sm\) var\(--space-md\)\s*;/);

    const inlineControlsRule = findRule(
      mobileBlocks,
      /\.wf-field input,\s*\.wf-field textarea,\s*\.wf-field select,[^}]*\.wf-ai-prompt\s*\{[^}]*\}/,
    );
    expect(inlineControlsRule).toMatch(/min-height\s*:\s*var\(--wf-editor-touch-target\)\s*;/);
    expect(inlineControlsRule).toMatch(/padding\s*:\s*var\(--space-sm\) var\(--space-md\)\s*;/);

    const mobileBackRule = findRule(mobileBlocks, /\.wf-editor-mobile-back\s*\{[^}]*\}/);
    expect(mobileBackRule).toMatch(/min-height\s*:\s*var\(--wf-editor-touch-target\)\s*;/);
    expect(mobileBackRule).toMatch(/padding\s*:\s*var\(--space-sm\) var\(--space-md\)\s*;/);

    const desktopListRule = findRule([baseCss], /\.wf-editor-list-item\s*\{[^}]*\}/);
    expect(desktopListRule).not.toMatch(/min-height\s*:/);
    expect(editorCss).not.toMatch(/@media \(max-width: 768px\)\s*\{[^}]*\.btn\s*\{/s);
  });

  it("FN-5992 covers create dialog and AI panel mobile overlays", () => {
    const editorCss = readComponentCss("WorkflowNodeEditor.css");
    const mobileBlocks = extractMediaBlocks(editorCss, "(max-width: 768px)");

    // FNXC:WorkflowEditorFloatingModal 2026-06-25-19:02: The workflow editor modal now uses FloatingWindow, so the mobile overlay stretch contract only applies to the create dialog overlay. The editor takeover is covered by floating-window mobile rules and must not reintroduce a .wf-editor-modal overlay selector.
    const overlayRule = findRule(
      mobileBlocks,
      /\.modal-overlay:has\(\.wf-create-modal\)\s*\{[^}]*\}/,
    );
    expect(overlayRule).toMatch(/padding-top\s*:\s*0\s*;/);
    expect(overlayRule).toMatch(/align-items\s*:\s*stretch\s*;/);

    const templateListRule = findRule(mobileBlocks, /\.wf-template-list\s*\{[^}]*\}/);
    expect(templateListRule).toMatch(/max-height\s*:\s*40vh\s*;/);

    const aiPanelRule = findRule(mobileBlocks, /\.wf-ai-panel\s*\{[^}]*\}/);
    expect(aiPanelRule).toMatch(/position\s*:\s*fixed\s*;/);
    expect(aiPanelRule).toMatch(/inset\s*:\s*var\(--space-sm\)\s*;/);
    expect(aiPanelRule).toMatch(/z-index\s*:\s*30\s*;/);
  });

  it("FN-5992 adds standalone mobile workflow panel overrides", () => {
    const settingsCss = readComponentCss("WorkflowSettingsPanel.css");
    const fieldsCss = readComponentCss("WorkflowFieldsPanel.css");
    const selectorCss = readComponentCss("WorkflowSelector.css");

    const settingsMobile = extractMediaBlocks(settingsCss, "(max-width: 768px)");
    const settingsRule = findRule(settingsMobile, /\.wf-settings-panel\s*\{[^}]*\}/);
    expect(settingsRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(settingsRule).toMatch(/min-width\s*:\s*0\s*;/);

    const fieldsMobile = extractMediaBlocks(fieldsCss, "(max-width: 768px)");
    const fieldsRule = findRule(fieldsMobile, /\.wf-fields-panel\s*\{[^}]*\}/);
    expect(fieldsRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(fieldsRule).toMatch(/min-width\s*:\s*0\s*;/);

    const selectorMobile = extractMediaBlocks(selectorCss, "(max-width: 768px)");
    const selectorRule = findRule(selectorMobile, /\.workflow-selector\s*\{[^}]*\}/);
    expect(selectorRule).toMatch(/flex-direction\s*:\s*column\s*;/);

    const manageRule = findRule(
      selectorMobile,
      /\.workflow-selector select,\s*\.workflow-selector-manage\s*\{[^}]*\}/,
    );
    expect(manageRule).toMatch(/width\s*:\s*100%\s*;/);
  });
});
