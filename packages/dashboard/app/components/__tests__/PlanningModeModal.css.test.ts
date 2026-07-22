import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getMediaBlocks } from "./PlanningModeModal.test-helpers";

const PLANNING_CSS_PATH = resolve(__dirname, "..", "PlanningModeModal.css");
const TABLET_SUMMARY_ACTIONS_QUERY = "@media (min-width: 769px) and (max-width: 1024px)";
const MOBILE_ACTIONS_QUERY = "@media (max-width: 768px)";
const MOBILE_PLANNING_SHELL_QUERY = "@media (max-width: 768px), (max-height: 480px)";
const DESKTOP_PLANNING_WORKSPACE_QUERY = "@media (min-width: 1025px)";

function loadPlanningCss(): string {
  return readFileSync(PLANNING_CSS_PATH, "utf-8");
}

function findRule(css: string, selector: string): string | undefined {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`))?.[0];
}

function findRules(css: string, selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, "g"))].map((match) => match[0]);
}

function expectSomeRule(css: string, selector: string, pattern: RegExp): void {
  expect(findRules(css, selector).some((rule) => pattern.test(rule))).toBe(true);
}

describe("PlanningModeModal CSS responsive action contract", () => {
  it("FN-6974 keeps the summary action footer from overflowing on tablet while preserving desktop and mobile affordances", () => {
    const css = loadPlanningCss();
    const baseSummaryActionsRule = findRule(css, ".planning-summary-actions");
    const baseSummaryRightRule = findRule(css, ".planning-summary-actions-right");

    expect(baseSummaryActionsRule).toContain("justify-content: space-between;");
    expect(baseSummaryRightRule).toContain("display: flex;");

    const tabletCss = getMediaBlocks(css, TABLET_SUMMARY_ACTIONS_QUERY).join("\n");
    expect(tabletCss).toBeTruthy();
    expect(findRule(tabletCss, ".planning-summary-actions")).toMatch(/flex-wrap\s*:\s*wrap\s*;/);
    expect(findRule(tabletCss, ".planning-summary-actions")).toMatch(/min-width\s*:\s*0\s*;/);
    expect(findRule(tabletCss, ".planning-summary-actions-right")).toMatch(/flex-wrap\s*:\s*wrap\s*;/);
    expect(findRule(tabletCss, ".planning-summary-actions-right")).toMatch(/min-width\s*:\s*0\s*;/);
    expect(findRule(tabletCss, ".planning-summary-actions-right")).toMatch(/max-width\s*:\s*100%\s*;/);
    expect(findRule(tabletCss, ".planning-summary-actions .btn")).toMatch(/max-width\s*:\s*100%\s*;/);
    expect(findRule(tabletCss, ".planning-summary-actions .btn")).toMatch(/white-space\s*:\s*normal\s*;/);

    const mobileCss = getMediaBlocks(css, MOBILE_ACTIONS_QUERY).join("\n");
    expectSomeRule(mobileCss, ".planning-actions", /flex-direction\s*:\s*column\s*;/);
    expectSomeRule(mobileCss, ".planning-summary-actions-right", /flex-direction\s*:\s*column\s*;/);
    expectSomeRule(mobileCss, ".planning-summary-actions-right", /width\s*:\s*100%\s*;/);
  });

  // FNXC:PlanningMode 2026-06-25-13:10: regression for the embedded Planning view not
  // scrolling on mobile. The global mobile `.modal:not(.confirm-dialog), .modal-lg, ...`
  // 100dvh rule (specificity 0,2,0) matched the embedded shell and stretched it past its
  // bounded `.planning-view` pane, so `.planning-view { overflow:hidden }` clipped the
  // footer action buttons. The mobile embedded override must (a) qualify with
  // `.planning-view.open` so it outranks (0,3,0 > 0,2,0) that global rule, and (b) re-pin
  // `max-height` so the embedded shell cannot exceed its pane and the inner flex scroll
  // chain works.
  it("pins the embedded view to its bounded pane height on mobile so the footer scrolls into reach", () => {
    const css = loadPlanningCss();
    const mobileCss = getMediaBlocks(css, MOBILE_ACTIONS_QUERY).join("\n");

    const embeddedRule = findRule(mobileCss, ".planning-view.open .planning-modal--embedded");
    expect(embeddedRule).toBeTruthy();
    expect(embeddedRule).toMatch(/height\s*:\s*100%\s*;/);
    expect(embeddedRule).toMatch(/max-height\s*:\s*100%\s*;/);
  });

  it("keeps question left and plan right on desktop, then uses full-view tabs on mobile", () => {
    const css = loadPlanningCss();
    const desktopRule = findRule(css, ".planning-workspace");
    expect(desktopRule).toMatch(/grid-template-areas\s*:\s*"question plan"\s*;/);
    // FNXC:PlanningMode 2026-07-21-16:47: interview panes sit flush — no outer workspace gutter or inter-pane gap.
    expect(desktopRule).toMatch(/padding\s*:\s*0\s*;/);
    expect(desktopRule).toMatch(/gap\s*:\s*0\s*;/);
    expect(findRule(css, ".planning-plan-pane")).toMatch(/grid-area\s*:\s*plan\s*;/);
    expectSomeRule(css, ".planning-question-pane", /grid-area\s*:\s*question\s*;/);
    expectSomeRule(css, ".planning-question-pane", /border-right\s*:\s*solid var\(--btn-border-width\)/);
    expect(findRule(css, ".planning-plan-pane,\n.planning-question-pane")).toMatch(/border-radius\s*:\s*0\s*;/);

    const mobileCss = getMediaBlocks(css, MOBILE_ACTIONS_QUERY).join("\n");
    expect(findRule(mobileCss, ".planning-workspace--mobile-tab-question,\n  .planning-workspace--mobile-tab-plan")).toMatch(/"tabs"\s*"content"/);
    expect(findRule(mobileCss, ".planning-workspace-tabs")).toMatch(/display\s*:\s*grid\s*;/);
    expect(findRule(mobileCss, ".planning-workspace--mobile-tab-question .planning-plan-pane,\n  .planning-workspace--mobile-tab-plan .planning-question-pane")).toMatch(/display\s*:\s*none\s*;/);
    // Mobile restores a compact card inset because only one pane is visible at a time.
    expect(findRule(mobileCss, ".planning-workspace")).toMatch(/padding\s*:\s*var\(--space-md\)\s*;/);
    expect(findRule(mobileCss, ".planning-question-pane")).toMatch(/border-right\s*:\s*none\s*;/);
  });

  it("keeps desktop planning content flush inside both panes with compact aligned action rows", () => {
    const css = loadPlanningCss();
    const desktopCss = getMediaBlocks(css, DESKTOP_PLANNING_WORKSPACE_QUERY).join("\n");
    const flushScrollRule = findRule(desktopCss, ".planning-question-pane .planning-question-scroll,\n  .planning-plan-pane .planning-plan-scroll");
    const desktopQuestionPanelRule = findRule(desktopCss, ".planning-question-pane .planning-question-panel");
    const desktopPlanDocumentRule = findRule(desktopCss, ".planning-plan-pane .planning-plan-document");
    const sharedActionsRule = findRule(desktopCss, ".planning-question-pane .planning-actions,\n  .planning-plan-actions");
    const sharedButtonsRule = findRule(desktopCss, ".planning-question-pane .planning-actions .btn,\n  .planning-plan-actions .btn");

    expect(flushScrollRule).toMatch(/padding\s*:\s*0\s*;/);
    expect(desktopQuestionPanelRule).toMatch(/border\s*:\s*none\s*;/);
    expect(desktopQuestionPanelRule).toMatch(/border-radius\s*:\s*0\s*;/);
    expect(desktopPlanDocumentRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(desktopPlanDocumentRule).toMatch(/box-shadow\s*:\s*none\s*;/);
    expect(sharedActionsRule).toMatch(/padding\s*:\s*var\(--space-sm\) var\(--space-xl\)\s*;/);
    expect(sharedButtonsRule).toMatch(/min-height\s*:\s*calc\(var\(--space-2xl\) \+ var\(--space-sm\)\)\s*;/);

    expect(findRule(css, ".planning-question-panel")).toMatch(/border\s*:\s*var\(--btn-border-width\) solid var\(--border\)\s*;/);
    expect(findRules(css, ".planning-plan-document").some((rule) => /border-radius\s*:\s*var\(--radius-xl\)\s*;/.test(rule))).toBe(true);
  });

  it("makes the history sheet full width on mobile while keeping its own scroll owner", () => {
    const css = loadPlanningCss();
    expect(findRule(css, ".planning-history-scroll")).toMatch(/overflow-y\s*:\s*auto\s*;/);
    expect(findRule(css, ".planning-history-panel")).toMatch(/width\s*:\s*min\(100%, calc\(var\(--space-2xl\) \* 15\)\)\s*;/);

    const mobileCss = getMediaBlocks(css, MOBILE_ACTIONS_QUERY).join("\n");
    expect(findRule(mobileCss, ".planning-history-panel")).toMatch(/width\s*:\s*100%\s*;/);
  });

  it("uses consistent full-width header controls without crowding the mobile session title", () => {
    const css = loadPlanningCss();
    const backRule = findRule(css, ".planning-session-back");
    expect(findRule(css, ".planning-header-controls")).toMatch(/gap\s*:\s*var\(--space-sm\)\s*;/);
    expect(findRule(css, ".planning-header-controls .btn")).toMatch(/min-height\s*:\s*calc\(var\(--space-2xl\) \+ var\(--space-sm\)\)\s*;/);
    expect(backRule).toMatch(/display\s*:\s*inline-flex\s*;/);
    expect(backRule).toMatch(/min-width\s*:\s*calc\(var\(--space-md\) \* 2\.25\)\s*;/);
    expect(backRule).toMatch(/min-height\s*:\s*calc\(var\(--space-md\) \* 2\.25\)\s*;/);

    const mobileCss = getMediaBlocks(css, MOBILE_ACTIONS_QUERY).join("\n");
    expect(findRule(mobileCss, ".planning-modal--embedded .modal-header--embedded")).toMatch(/flex-wrap\s*:\s*wrap\s*;/);
    expect(findRule(mobileCss, ".planning-header-controls")).toMatch(/grid-template-columns\s*:\s*minmax\(0, 1fr\)\s*;/);
    expect(findRule(mobileCss, ".planning-header-controls")).toMatch(/width\s*:\s*100%\s*;/);
    expect(findRule(mobileCss, ".planning-modal--embedded .modal-header--embedded .detail-title-row")).toMatch(/flex-wrap\s*:\s*nowrap\s*;/);
    expect(findRule(mobileCss, ".planning-modal--embedded .modal-header--embedded .detail-title-row")).toMatch(/overflow\s*:\s*hidden\s*;/);
    expect(findRule(mobileCss, ".planning-modal--embedded .modal-header--embedded .detail-title-row h3")).toMatch(/flex\s*:\s*1 1 auto\s*;/);
    expect(findRule(mobileCss, ".planning-modal--embedded .modal-header--embedded .detail-title-row h3")).toMatch(/min-width\s*:\s*0\s*;/);
    expect(findRule(mobileCss, ".planning-modal--embedded .modal-header--embedded .detail-title-row h3")).toMatch(/text-overflow\s*:\s*ellipsis\s*;/);
    expect(findRule(mobileCss, ".planning-modal--embedded .modal-header--embedded .detail-title-row h3")).toMatch(/white-space\s*:\s*nowrap\s*;/);
    expect(findRule(mobileCss, ".planning-modal--embedded .modal-header--embedded .detail-title-row > svg,\n  .planning-modal--embedded .modal-header--embedded .detail-title-row > .btn-icon,\n  .planning-modal--embedded .modal-header--embedded .planning-session-back")).toMatch(/flex\s*:\s*0 0 auto\s*;/);
  });

  it("keeps tablet question and plan actions on one aligned row with a tight bottom inset", () => {
    const css = loadPlanningCss();
    const tabletCss = getMediaBlocks(css, TABLET_SUMMARY_ACTIONS_QUERY).join("\n");
    const sharedFooterRule = findRule(tabletCss, ".planning-question-pane .planning-actions,\n  .planning-plan-actions");
    const sharedButtonRule = findRule(tabletCss, ".planning-question-pane .planning-actions .btn,\n  .planning-plan-actions .btn");

    expect(sharedFooterRule).toMatch(/align-items\s*:\s*stretch\s*;/);
    expect(sharedFooterRule).toMatch(/min-height\s*:\s*calc\(var\(--space-2xl\) \+ var\(--space-xl\)\)\s*;/);
    expect(sharedFooterRule).toMatch(/padding\s*:\s*var\(--space-sm\) var\(--space-lg\) var\(--space-xs\)\s*;/);
    expect(sharedButtonRule).toMatch(/flex\s*:\s*1 1 0\s*;/);
    expect(sharedButtonRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(sharedButtonRule).toMatch(/min-height\s*:\s*calc\(var\(--space-2xl\) \+ var\(--space-md\)\)\s*;/);
    expectSomeRule(tabletCss, ".planning-plan-actions", /display\s*:\s*flex\s*;/);
    expectSomeRule(tabletCss, ".planning-plan-actions", /flex-wrap\s*:\s*nowrap\s*;/);
  });

  it("keeps the mobile sessions list scrolling above the bottom-pinned New session footer", () => {
    const css = loadPlanningCss();
    const mobileShellCss = getMediaBlocks(css, MOBILE_PLANNING_SHELL_QUERY).join("\n");

    const showListRule = findRule(mobileShellCss, ".planning-modal-body--show-list");
    expect(showListRule).toBeTruthy();
    expect(showListRule).toMatch(/flex\s*:\s*1\s*;/);
    expect(showListRule).toMatch(/min-height\s*:\s*0\s*;/);
    expect(showListRule).toMatch(/overflow\s*:\s*hidden\s*;/);

    const sidebarRule = findRule(mobileShellCss, ".planning-modal-body--show-list .planning-sidebar");
    expect(sidebarRule).toBeTruthy();
    expect(sidebarRule).toMatch(/flex\s*:\s*1 1 auto\s*;/);
    expect(sidebarRule).toMatch(/height\s*:\s*100%\s*;/);
    expect(sidebarRule).toMatch(/min-height\s*:\s*0\s*;/);
    expect(sidebarRule).toMatch(/max-height\s*:\s*100%\s*;/);

    const sidebarListRule = findRule(mobileShellCss, ".planning-modal-body--show-list .planning-sidebar-list");
    expect(sidebarListRule).toBeTruthy();
    expect(sidebarListRule).toMatch(/flex\s*:\s*1 1 auto\s*;/);
    expect(sidebarListRule).toMatch(/min-height\s*:\s*0\s*;/);
    expect(sidebarListRule).toMatch(/overflow-y\s*:\s*auto\s*;/);

    const footerRule = findRule(mobileShellCss, ".planning-modal-body--show-list .planning-sidebar-footer");
    expect(footerRule).toBeTruthy();
    expect(footerRule).toMatch(/flex-shrink\s*:\s*0\s*;/);
  });
});
