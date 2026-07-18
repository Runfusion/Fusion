import { describe, expect, it } from "vitest";
import { createSmokeHtml } from "../../scripts/browser-layout-smoke.mjs";

describe("browser layout smoke fixture", () => {
  it("includes PR flow fixture sections and class hooks", () => {
    const html = createSmokeHtml();
    expect(html).toContain('data-smoke="pr-create-modal"');
    expect(html).toContain('data-smoke="pr-panel"');
    expect(html).toContain('data-smoke="pr-checks"');
    expect(html).toContain("pr-create-modal__preflight-row");
    expect(html).toContain("pr-panel-check-chip--error");
    expect(html).toContain("pr-checks__details-link");
  });

  it("includes localized Quick Add Save fixtures for Board and List composers", () => {
    const html = createSmokeHtml();
    expect(html).toContain('data-smoke="quick-add-save-fixtures"');
    expect(html).toContain('data-smoke="quick-add-save-board-minimum-fr"');
    expect(html).toContain('data-smoke="quick-add-save-list-minimum-fr"');
    expect(html).toContain("quick-entry--single-line");
    expect(html).toContain('data-smoke="quick-add-save-row"');
    expect(html).toContain('data-smoke="quick-add-save-button"');
    expect(html).toContain('data-testid="quick-entry-session-advisor-toggle"');
    expect(html.match(/data-testid="quick-entry-(?:attach|github-toggle|session-advisor-toggle|priority-button|fast-toggle)"/g)).toHaveLength(120);
    for (const label of ["Save", "Guardar", "Enregistrer", "저장", "保存", "儲存"]) {
      expect(html).toContain(label);
    }
  });
});
