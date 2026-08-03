import { describe, expect, it } from "vitest";
import { createSmokeHtml } from "../../scripts/browser-layout-smoke.mjs";

describe("browser layout smoke fixture", () => {
  it("includes standalone and embedded Git Manager shell fixtures", () => {
    const html = createSmokeHtml();
    for (const hook of [
      "git-manager-standalone",
      "git-manager-standalone-body",
      "git-manager-standalone-modal",
      "git-manager-standalone-header",
      "git-manager-standalone-close",
      "git-manager-standalone-layout",
      "git-manager-standalone-content",
      "git-manager-embedded-host",
      "git-manager-embedded-modal",
      "git-manager-embedded-header",
      "git-manager-embedded-close",
      "git-manager-embedded-layout",
      "git-manager-embedded-content",
    ]) {
      expect(html).toContain(`data-smoke="${hook}"`);
    }
    expect(html).toContain("floating-window--git-manager");
    expect(html).toContain("gm-modal--embedded");
  });

  it("includes standalone, embedded, and detail GitHub Import shell fixtures", () => {
    const html = createSmokeHtml();
    for (const hook of [
      "github-import-standalone", "github-import-standalone-body", "github-import-standalone-modal",
      "github-import-standalone-header", "github-import-standalone-close", "github-import-standalone-controls",
      "github-import-standalone-list", "github-import-standalone-pagination", "github-import-standalone-footer",
      "github-import-embedded-host", "github-import-embedded-modal", "github-import-embedded-header",
      "github-import-embedded-content", "github-import-detail", "github-import-detail-body",
      "github-import-detail-panel", "github-import-detail-close",
    ]) {
      expect(html).toContain(`data-smoke="${hook}"`);
    }
    expect(html).toContain("floating-window--github-import");
    expect(html).toContain("github-import-modal--embedded");
    expect(html).toContain("floating-window--github-import-detail");
  });

  it("includes PR flow fixture sections and class hooks", () => {
    const html = createSmokeHtml();
    expect(html).toContain('data-smoke="pr-create-modal"');
    expect(html).toContain('data-smoke="pr-panel"');
    expect(html).toContain('data-smoke="pr-checks"');
    expect(html).toContain("pr-create-modal__preflight-row");
    expect(html).toContain("pr-panel-check-chip--error");
    expect(html).toContain("pr-checks__details-link");
  });

  it("includes Task Detail inline icon fixtures for all optional-control variants", () => {
    const html = createSmokeHtml();
    expect(html).toContain('data-smoke="task-detail-inline-row-fixtures"');
    for (const variant of ["full", "without-github", "without-oversight", "without-optionals"]) {
      expect(html).toContain(`data-smoke="task-detail-inline-row-${variant}"`);
    }
    for (const testId of [
      "detail-inline-attach",
      "detail-inline-github-toggle",
      "detail-oversight-menu-trigger",
      "detail-priority-trigger",
      "detail-execution-mode-toggle",
    ]) {
      expect(html).toContain(`data-testid="${testId}"`);
    }
    expect(html).toContain('<span class="provider-icon"><svg width="16" height="16"');
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
