import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getMediaBlocks } from "./PlanningModeModal.test-helpers";

const PLANNING_CSS_PATH = resolve(__dirname, "..", "PlanningModeModal.css");
const TABLET_SUMMARY_ACTIONS_QUERY = "@media (min-width: 769px) and (max-width: 1024px)";
const MOBILE_ACTIONS_QUERY = "@media (max-width: 768px)";
const MOBILE_PLANNING_SHELL_QUERY = "@media (max-width: 768px), (max-height: 480px)";

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

  it("uses the compact interview switcher for mobile, short landscape, and tablet instead of crushing three panes", () => {
    const css = loadPlanningCss();
    const shortShellCss = getMediaBlocks(css, MOBILE_PLANNING_SHELL_QUERY).join("\n");
    const tabletCss = getMediaBlocks(css, TABLET_SUMMARY_ACTIONS_QUERY).join("\n");

    expect(findRule(shortShellCss, ".planning-modal-body--compact-interview")).toMatch(/flex-direction\s*:\s*column\s*;/);
    expect(findRule(shortShellCss, ".planning-compact-pane-switcher")).toMatch(/display\s*:\s*flex\s*;/);
    expect(findRule(shortShellCss, ".planning-compact-pane-switcher .btn")).toMatch(/min-height\s*:\s*calc\(var\(--space-md\) \* 2\.25\)\s*;/);
    expect(shortShellCss).toContain(".planning-modal-body--compact-question .planning-running-plan");
    expect(shortShellCss).toContain(".planning-modal-body--compact-plan .planning-detail");
    expect(shortShellCss).toContain(".planning-modal-body--compact-history .planning-detail");
    expect(findRule(tabletCss, ".planning-modal-body--compact-interview")).toMatch(/flex-direction\s*:\s*column\s*;/);
    expect(tabletCss).toContain(".planning-modal-body--compact-question .planning-running-plan");

    expectSomeRule(css, ".planning-running-plan", /flex\s*:\s*0 1 24rem\s*;/);
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
