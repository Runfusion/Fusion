import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const githubImportCss = readFileSync(
  resolve(__dirname, "../components/GitHubImportModal.css"),
  "utf8",
);

function extractBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `missing ${marker}`).toBeGreaterThanOrEqual(0);
  const openingBrace = source.indexOf("{", start);
  let depth = 0;

  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }

  throw new Error(`unterminated ${marker}`);
}

function extractRule(source: string, selector: string): string {
  return extractBlock(source, `${selector} {`);
}

describe("GitHub import pull-request mobile layout (FN-9110)", () => {
  it("lets Pull Requests rows grow and wraps unbroken branch names at the phone breakpoint", () => {
    const phoneRules = extractBlock(githubImportCss, "@media (max-width: 640px)");
    const rowRule = extractRule(phoneRules, ".issue-item");
    const branchRule = extractRule(phoneRules, ".pull-branch-info");

    expect(rowRule).toContain("flex-wrap: wrap;");
    expect(rowRule).not.toMatch(/min-height\s*:/);
    expect(branchRule).toContain("min-width: 0;");
    expect(branchRule).toContain("overflow-wrap: anywhere;");
  });

  it("contains long PR preview branch text and keeps the detail body scrollable on narrow sheets", () => {
    const detailActionSection = githubImportCss.slice(
      githubImportCss.indexOf("The selected-issue mobile action row"),
    );
    const narrowRules = extractBlock(detailActionSection, "@media (max-width: 768px)");
    const previewBranchRule = extractRule(narrowRules, ".preview-branch");
    const detailPanelRule = extractRule(githubImportCss, ".github-import-detail-panel");

    expect(previewBranchRule).toContain("min-width: 0;");
    expect(previewBranchRule).toContain("overflow-wrap: anywhere;");
    expect(detailPanelRule).toContain("min-height: 0;");
    expect(detailPanelRule).toContain("overflow: hidden;");
  });
});
