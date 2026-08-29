import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";

describe("WorkflowResultsTab CSS contract", () => {
  it("FN-4242 tokenizes phase badge font size and preserves output-header wrap behavior", async () => {
    const baseCss = await loadAllAppCssBaseOnly();
    const allCss = await loadAllAppCss();

    const phaseBadgeRule = baseCss.match(/\.phase-badge\s*\{[^}]*\}/)?.[0] ?? "";
    expect(phaseBadgeRule).toContain("font-size");
    expect(phaseBadgeRule).not.toMatch(/font-size\s*:\s*\d+px\s*;/);
    expect(phaseBadgeRule).toMatch(/font-size\s*:\s*[^;]*var\(--space-/);

    expect(baseCss).toMatch(/\.workflow-result-output-header\s*\{[^}]*flex-wrap\s*:\s*wrap\s*;/);

    expect(allCss).toContain("@media (max-width: 768px)");
    expect(allCss).toMatch(/\.workflow-result-output-header\s*\{[^}]*align-items\s*:\s*flex-start\s*;/);
  });

  it("FN-4352: workflow expand toggle avoids mobile min-size inflation", async () => {
    const allCss = await loadAllAppCss();
    expect(allCss).not.toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.workflow-result-expand-toggle\s*\{[^}]*min-height\s*:/);
    expect(allCss).not.toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.workflow-result-expand-toggle\s*\{[^}]*min-width\s*:/);
  });
});
