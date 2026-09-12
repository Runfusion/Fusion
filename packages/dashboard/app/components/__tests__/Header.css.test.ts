import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const css = readAppFile("components/Header.css");
const taskSearchCss = readAppFile("components/TaskSearchInput.css");

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

  it("positions task suggestions above content with token-based paint and mobile touch sizing", () => {
    const suggestions = extractRuleBlock(taskSearchCss, ".task-search-suggestions");
    const option = extractRuleBlock(taskSearchCss, ".task-search-suggestion");

    expect(suggestions).toContain("position: absolute;");
    expect(suggestions).toContain("z-index: var(--z-dropdown);");
    expect(suggestions).toContain("background: var(--surface);");
    expect(suggestions).toContain("border: var(--btn-border-width) solid var(--border);");
    expect(option).toContain("min-height: calc(var(--space-xl) + var(--space-md));");
    expect(taskSearchCss).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.task-search-suggestion\s*\{[^}]*min-height:\s*calc\(var\(--space-xl\) \+ var\(--space-xl\)\);/);
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

  it("compacts the workflow portal in the mobile top header", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-workflow-slot\s*\{[^}]*flex:\s*1 1 auto;[^}]*justify-content:\s*center;[^}]*max-width:\s*none;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-actions\s*\{[^}]*flex:\s*0 0 auto;[^}]*align-items:\s*center;[^}]*gap:\s*var\(--space-sm\);/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-workflow-slot \.board-workflow-toolbar,\s*\n\s*\.header-workflow-slot \.list-workflow-control\s*\{[^}]*height:\s*32px;[^}]*align-items:\s*center;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-workflow-slot \.workflow-switcher\s*\{[^}]*width:\s*clamp\(calc\(var\(--space-2xl\) \* 3\.25\),\s*36vw,\s*calc\(var\(--space-2xl\) \* 4\)\);[^}]*height:\s*32px;[^}]*max-height:\s*32px;[^}]*align-items:\s*center;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-workflow-slot \.workflow-switcher-trigger\s*\{[^}]*appearance:\s*none;[^}]*height:\s*32px;[^}]*min-height:\s*32px;[^}]*max-height:\s*32px;[^}]*line-height:\s*1;[^}]*overflow:\s*hidden;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-workflow-slot \.workflow-switcher-label\s*\{[^}]*display:\s*none;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.header-workflow-slot \.workflow-switcher-counts\s*\{[^}]*display:\s*none;/);
  });
});
