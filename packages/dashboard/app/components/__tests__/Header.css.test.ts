import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const css = fs.readFileSync(path.resolve(__dirname, "../Header.css"), "utf8");

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
