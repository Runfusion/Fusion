import fs from "node:fs";
import { loadAllAppCss } from "../../test/cssFixture";
import path from "node:path";
import { describe, expect, it } from "vitest";


function getMissionMobileSection(css: string): string {
  const start = css.indexOf("/* ================================================================\n   Responsive — Mission Manager on mobile (≤768px)");
  expect(start).toBeGreaterThan(-1);

  // After CSS extraction, the Workflow Results block lives in
  // WorkflowResultsTab.css; the mission mobile section now ends just before
  // the appended light-theme overrides at the end of MissionManager.css.
  const end = css.indexOf("/* Light theme overrides", start);
  expect(end).toBeGreaterThan(start);

  return css.slice(start, end);
}

describe("MissionManager mobile styles", () => {
  /*
  FNXC:MissionRowActions 2026-09-17-03:18:
  FN-486 : les réparations de validation ne sont plus des boutons icône de ligne à dimensionner ; ce sont des
  rangées du menu contextuel partagé, qui porte sa propre cible tactile. Les conteneurs d'actions de ligne et
  leurs règles tactiles doivent donc avoir disparu de toute la feuille, sur les deux surfaces de feature.
  */
  it("keeps no touch-sizing rule for the removed hierarchy row action containers", () => {
    const css = loadAllAppCss();
    expect(css).not.toContain(".mission-feature__actions");
    expect(css).not.toContain(".mission-fix-feature__actions");
    expect(css).not.toContain(".mission-milestone__actions");
    expect(css).not.toContain(".mission-slice__actions");
    const menuRow = css.slice(css.indexOf(".list-item-context-menu__item {"));
    expect(menuRow).toContain("min-block-size: var(--touch-target-min-size);");
  });

  it("keeps reconcile preview controls touch-sized", () => {
    const section = getMissionMobileSection(loadAllAppCss());
    expect(section).toContain('.mission-detail__run-controls > [data-testid="mission-reconcile-now"]');
    expect(section).toContain(".mission-detail__reconcile-actions .mission-btn");
    expect(section).toContain("min-width: 36px;");
    expect(section).toContain("min-height: 36px;");
  });

  it("adds responsive tab and activity layout rules", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);

    expect(section).toContain(".mission-detail__tabs {");
    expect(section).toContain("overflow-x: auto;");
    expect(section).toContain(".mission-detail__activity-controls {");
    expect(section).toContain("flex-direction: column;");
    expect(section).toContain(".mission-detail__activity-filter,");
    expect(section).toContain(".mission-detail__activity-filter select {");
    expect(section).toContain("width: 100%;");
  });

  it("adds mobile overflow protection for activity event content", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);

    expect(section).toContain(".mission-events {");
    expect(section).toContain("max-height: min(46vh, 360px);");
    expect(section).toContain(".mission-event__description,");
    expect(section).toContain("overflow-wrap: anywhere;");
    expect(section).toContain("word-break: break-word;");
  });

  it("clamps stacked mission list descriptions on mobile", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);

    expect(section).toContain(".mission-manager__body--stacked .mission-list__item-description,");
    expect(section).toContain("display: -webkit-box;");
    expect(section).toContain("-webkit-line-clamp: 2;");
  });

  /*
  FNXC:MissionRowActions 2026-09-17-03:18:
  FN-486 : la ligne empilée reste une colonne pleine largeur, mais elle n'héberge plus de conteneur d'actions
  permanentes à empiler — ces commandes vivent dans le menu contextuel. Les règles correspondantes doivent
  donc avoir disparu partout, et pas seulement être masquées sur téléphone.
  */
  it("stacks stacked-body mission cards on mobile and keeps no permanent row action container", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);

    expect(section).toContain(".mission-manager__body--stacked .mission-list__item {");
    expect(section).toContain("flex-direction: column;");
    expect(section).toContain("align-items: stretch;");
    expect(css).not.toContain(".mission-list__item-actions");
    expect(css).not.toContain(".mission-list__item-run-controls");
  });

  it("keeps mission detail mobile bottom padding content-only (no shared nav duplication)", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);
    const detailRule = section.match(/\.mission-detail\s*\{[^}]*\}/)?.[0] ?? "";

    expect(detailRule).toContain("padding-bottom: var(--space-lg);");
    expect(detailRule).not.toContain("safe-area-inset-bottom");
    expect(detailRule).not.toContain("--mobile-nav-height");
  });

  it("hides desktop split layout on mobile", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);

    expect(section).toContain(".mission-manager__split {");
    expect(section).toContain("display: none;");
  });

  it("restores stacked body on mobile", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);

    expect(section).toContain(".mission-manager__body--stacked {");
    expect(section).toContain("display: block;");
  });

  it("keeps the mobile top mission CTA full-width, primary-styled, and tokenized", () => {
    const css = loadAllAppCss();
    const ctaRule = css.match(/\.mission-list__primary-cta\s*\{[^}]*\}/)?.[0];

    expect(ctaRule).toContain("width: 100%;");
    expect(ctaRule).toContain("min-height: calc(var(--space-lg) * 2 + var(--space-sm));");
    expect(ctaRule).toContain("justify-content: center;");
    expect(ctaRule).toContain("gap: var(--space-sm);");
  });

  it("hides back button on desktop and restores it on mobile", () => {
    const css = loadAllAppCss();
    const desktopRule = css.match(/\.mission-manager--desktop \.mission-manager__back-btn\s*\{[^}]*\}/)?.[0];
    expect(desktopRule).toContain("display: none;");

    const section = getMissionMobileSection(css);
    const mobileRule = section.match(/\.mission-manager--desktop \.mission-manager__back-btn\s*\{[^}]*\}/)?.[0];
    expect(mobileRule).toContain("display: inline-flex;");
  });

  it("keeps desktop defaults and mobile overrides for header title spans", () => {
    const css = loadAllAppCss();
    const desktopMobileSpanBlock = css.match(/\.mission-manager__title-text--mobile\s*\{[^}]*\}/)?.[0];
    const desktopDesktopSpanBlock = css.match(/\.mission-manager__title-text--desktop\s*\{[^}]*\}/)?.[0];
    expect(desktopMobileSpanBlock).toContain("display: none");
    expect(desktopDesktopSpanBlock).toContain("display: inline");

    const section = getMissionMobileSection(css);
    const mobileBlock = section.match(/\.mission-manager__title-text--mobile\s*\{[^}]*\}/)?.[0];
    const desktopBlock = section.match(/\.mission-manager__title-text--desktop\s*\{[^}]*\}/)?.[0];
    expect(mobileBlock).toContain("display: inline");
    expect(desktopBlock).toContain("display: none");
  });
});

describe("desktop two-panel split CSS", () => {
  it("defines sidebar with fixed width, border, and scroll", () => {
    const css = loadAllAppCss();
    expect(css).toContain(".mission-manager__sidebar {");
    // Sidebar width uses token-based calc instead of hardcoded px
    expect(css).toContain("flex-shrink: 0;");
    expect(css).toContain("border-right");
    expect(css).toContain("var(--border)");
  });

  it("defines detail pane with flex: 1 and overflow", () => {
    const css = loadAllAppCss();
    expect(css).toContain(".mission-manager__detail-pane {");
    expect(css).toContain("flex: 1;");
    expect(css).toContain("overflow-y: auto;");
  });

  it("hides back button on desktop", () => {
    const css = loadAllAppCss();
    expect(css).toContain(".mission-manager--desktop .mission-manager__back-btn {");
    expect(css).toContain("display: none;");
  });

  it("toggles header title variants on desktop", () => {
    const css = loadAllAppCss();
    expect(css).toContain(".mission-manager__title-text--desktop {");
    expect(css).toContain(".mission-manager__title-text--mobile {");
  });

  it("defines sidebar list with overflow scroll", () => {
    const css = loadAllAppCss();
    expect(css).toContain(".mission-manager__sidebar-list {");
    expect(css).toContain("overflow-y: auto;");
  });

  it("removes obsolete mission CTA wrappers, local rail geometry, and empty-state styling", () => {
    const css = loadAllAppCss();

    expect(css).not.toContain(".mission-manager__sidebar-footer");
    expect(css).not.toContain(".mission-manager__sidebar-cta-bar");
    expect(css).not.toContain(".mission-manager__sidebar-cta ");
    expect(css).not.toContain(".mission-manager__sidebar-resize-handle");
    expect(css).not.toContain(".mission-list__footer");
    expect(css).not.toContain(".mission-list__footer-actions");
    expect(css).not.toContain(".mission-manager__empty-cta");
  });

  it("defines split container as flex row", () => {
    const css = loadAllAppCss();
    expect(css).toContain(".mission-manager__split {");
    expect(css).toContain("flex-direction: row;");
  });

  it("defines empty detail pane placeholder", () => {
    const css = loadAllAppCss();
    expect(css).toContain(".mission-manager__detail-pane-empty {");
    expect(css).toContain("var(--text-muted)");
  });
});

describe("mobile split reversal CSS", () => {
  it("hides desktop split on mobile", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);
    expect(section).toContain(".mission-manager__split {");
    expect(section).toContain("display: none;");
  });

  it("restores stacked body on mobile", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);
    expect(section).toContain(".mission-manager__body--stacked {");
    expect(section).toContain("display: block;");
  });

  it("restores back button on mobile", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);
    const mobileRule = section.match(/\.mission-manager--desktop \.mission-manager__back-btn\s*\{[^}]*\}/)?.[0];
    expect(mobileRule).toContain("display: inline-flex;");
  });

  it("restores dynamic title on mobile", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);
    const mobileBlock = section.match(/\.mission-manager__title-text--mobile\s*\{[^}]*\}/)?.[0];
    const desktopBlock = section.match(/\.mission-manager__title-text--desktop\s*\{[^}]*\}/)?.[0];
    expect(mobileBlock).toContain("display: inline");
    expect(desktopBlock).toContain("display: none");
  });
});

describe("Mission view overscroll containment", () => {
  it("adds overscroll-behavior containment to every mission scroll container", () => {
    const css = loadAllAppCss();

    const inlineRule = css.match(/\.mission-manager--inline\s*\{[^}]*\}/)?.[0] ?? "";
    const bodyRule = css.match(/\.mission-manager__body\s*\{[^}]*\}/)?.[0] ?? "";
    const sidebarRule = css.match(/\.mission-manager__sidebar-list\s*\{[^}]*\}/)?.[0] ?? "";
    const detailRule = css.match(/\.mission-manager__detail-pane\s*\{[^}]*\}/)?.[0] ?? "";
    const eventsRule = css.match(/\.mission-events\s*\{[^}]*\}/)?.[0] ?? "";

    expect(inlineRule).toContain("overscroll-behavior: contain;");
    expect(bodyRule).toContain("overscroll-behavior: contain;");
    expect(sidebarRule).toContain("overscroll-behavior: contain;");
    expect(detailRule).toContain("overscroll-behavior: contain;");
    expect(eventsRule).toContain("overscroll-behavior: contain;");
  });

  it("keeps webkit momentum scrolling on body and events containers", () => {
    const css = loadAllAppCss();
    const bodyRule = css.match(/\.mission-manager__body\s*\{[^}]*\}/)?.[0] ?? "";
    const eventsRule = css.match(/\.mission-events\s*\{[^}]*\}/)?.[0] ?? "";

    expect(bodyRule).toContain("-webkit-overflow-scrolling: touch;");
    expect(eventsRule).toContain("-webkit-overflow-scrolling: touch;");
  });
});

describe("MissionManager blocked repair mobile styles", () => {
  it("keeps the blocked diagnostics usable in stacked layout", () => {
    const css = loadAllAppCss();
    expect(css).toContain(".mission-manager__body--stacked .mission-blocked-repair");
    expect(css).toContain("inline-size: 100%;");
  });
});
