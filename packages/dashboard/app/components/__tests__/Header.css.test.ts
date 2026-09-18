import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const css = readAppFile("components/Header.css");
const taskSearchCss = readAppFile("components/TaskSearchInput.css");
const taskSearchResultsCss = readAppFile("components/TaskSearchResultsPopover.css");

/**
 * Strip CSS comments before scanning for removed selectors. The FNXC notes that EXPLAIN a removal
 * necessarily name the removed selector, and a guard that cannot tell documentation from a live rule
 * would push authors to delete the explanation instead of the dead style.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function extractRuleBlock(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`Missing selector ${selector}`);
  }

  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error(`Unterminated selector ${selector}`);
}

describe("Header CSS", () => {
  it("keeps the dashboard top shell header seamless by default", () => {
    const block = extractRuleBlock(css, ".header");

    expect(block).toContain("background: var(--surface);");
    expect(block).toContain("border-bottom: none;");
  });

  /*
  FNXC:TaskSearch 2026-09-17-09:41:
  FN-477 replaced the truncated suggestion dropdown with a portal panel of real task cards, so the
  old `.task-search-suggestion*` rules are GONE rather than restyled. These assertions moved to the
  panel that actually paints results; restoring the dead rules to satisfy the old wording would be
  shipping styles nothing renders.
  */
  it("paints the task results panel with tokens and leaves no dead suggestion-row styles behind", () => {
    const panel = extractRuleBlock(taskSearchResultsCss, ".task-search-results");

    expect(panel).toContain("z-index: var(--z-dropdown);");
    expect(panel).toContain("background: var(--surface);");
    expect(panel).toContain("border: var(--btn-border-width) solid var(--border);");
    // The panel is positioned from measured geometry, so it is fixed to the viewport, not absolute
    // inside a header that would clip it.
    expect(panel).toContain("position: fixed;");

    expect(withoutComments(taskSearchCss)).not.toContain(".task-search-suggestion");
    expect(withoutComments(taskSearchResultsCss)).not.toContain(".task-search-suggestion");
  });

  it("keeps result rows at card size with exactly one scroll owner", () => {
    const scroll = extractRuleBlock(taskSearchResultsCss, ".task-search-results-scroll");
    const result = extractRuleBlock(taskSearchResultsCss, ".task-search-result");

    expect(scroll).toContain("overflow-y: auto;");
    expect(scroll).toContain("overflow-x: hidden;");
    // Load-bearing: without it the flex column compresses the cards, and "1.5 complete cards" would
    // be satisfied only by cards that are no longer complete.
    expect(result).toContain("flex: 0 0 auto;");
    expect(taskSearchResultsCss).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.task-search-results\s*\{[^}]*max-inline-size:/);
  });

  /*
  FNXC:TaskSearch 2026-09-18-02:21:
  FN-525 replaced the header search close X with the AI-search trigger, so `.header-search-clear` is
  GONE rather than restyled — including its touch-target line in the compact media block.
  */
  it("paints the header AI search trigger with tokens and leaves no dead close-button styles behind", () => {
    const block = extractRuleBlock(css, ".header-search-ai");
    const disabled = extractRuleBlock(css, ".header-search-ai:disabled");

    expect(block).toContain("color: var(--text-muted);");
    expect(block).toContain("gap: var(--space-3xs);");
    expect(block).toContain("padding: var(--space-3xs) var(--space-xs);");
    expect(block).toContain("border-radius: var(--radius-sm);");
    expect(block).toContain("transition: color var(--transition-fast), background var(--transition-fast);");
    expect(disabled).toContain("cursor: default;");
    expect(disabled).toContain("color: var(--text-dim);");
    // The compact touch target must follow the surviving affordance, not stay orphaned on the X.
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-search-ai\s*\{[^}]*min-width:\s*36px;[^}]*min-height:\s*36px;/);
    expect(withoutComments(css)).not.toContain(".header-search-clear");
  });

  it("anchors Alpha desktop search inline with token-sized geometry and no overlay selectors", () => {
    const inline = extractRuleBlock(css, ".header-search--inline");

    expect(inline).toContain("flex: 0 1 calc(var(--space-2xl) * 8);");
    expect(inline).toContain("min-width: calc(var(--space-2xl) * 5);");
    expect(inline).toContain("max-width: calc(var(--space-2xl) * 10);");
    expect(css).not.toContain(".alpha-task-search-overlay");
  });

  it("keeps desktop workflow and search controls on one shrinkable row", () => {
    const actions = extractRuleBlock(css, ".header-actions");
    const slot = extractRuleBlock(css, ".header-workflow-slot");
    const toolbar = extractRuleBlock(css, ".header-workflow-slot .board-workflow-toolbar,\n.header-workflow-slot .list-workflow-control");
    const switcher = extractRuleBlock(css, ".header-workflow-slot .board-workflow-selector,\n.header-workflow-slot .workflow-switcher");
    const trigger = extractRuleBlock(css, ".header-workflow-slot .workflow-switcher-trigger");
    const fixedAction = extractRuleBlock(css, ".header-actions > .btn-icon");

    expect(actions).toContain("flex-wrap: nowrap;");
    expect(actions).toContain("flex: 0 1 auto;");
    expect(actions).toContain("min-width: 0;");
    expect(slot).toContain("flex: 1 1 auto;");
    expect(slot).toContain("flex-wrap: nowrap;");
    expect(toolbar).toContain("flex-wrap: nowrap;");
    expect(toolbar).toContain("width: 100%;");
    expect(switcher).toContain("flex: 1 1 auto;");
    expect(switcher).toContain("max-width: 100%;");
    expect(trigger).toContain("width: 100%;");
    expect(fixedAction).toContain("flex: 0 0 auto;");
  });

  /*
  FN-481 moved this compaction from a width to the PHONE MODE class `.header-workflow-slot--mobile`,
  so these assertions follow the selector that ships. A touch tablet at 768px CSS deliberately keeps
  the desktop presentation, which the old width-only selector could not express.
  */
  it("compacts the workflow portal in the mobile top header", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-workflow-slot--mobile\s*\{[^}]*flex:\s*1 1 auto;[^}]*justify-content:\s*center;[^}]*max-width:\s*none;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-actions\s*\{[^}]*flex:\s*0 0 auto;[^}]*align-items:\s*center;[^}]*gap:\s*var\(--space-sm\);/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-workflow-slot--mobile \.board-workflow-toolbar,\s*\n\s*\.header-workflow-slot--mobile \.list-workflow-control\s*\{[^}]*height:\s*32px;[^}]*align-items:\s*center;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-workflow-slot--mobile \.workflow-switcher\s*\{[^}]*width:\s*clamp\(calc\(var\(--space-2xl\) \* 3\.25\),\s*36vw,\s*calc\(var\(--space-2xl\) \* 4\)\);[^}]*height:\s*32px;[^}]*max-height:\s*32px;[^}]*align-items:\s*center;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-workflow-slot--mobile \.workflow-switcher-trigger\s*\{[^}]*appearance:\s*none;[^}]*height:\s*32px;[^}]*min-height:\s*32px;[^}]*max-height:\s*32px;[^}]*line-height:\s*1;[^}]*overflow:\s*hidden;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-workflow-slot--mobile \.workflow-switcher-label\s*\{[^}]*display:\s*none;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-workflow-slot--mobile \.workflow-switcher-counts\s*\{[^}]*display:\s*none;/);
  });
});
