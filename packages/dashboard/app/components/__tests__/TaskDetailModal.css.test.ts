import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";

function getCssRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ruleMatch = css.match(new RegExp(`(?:^|[}\n])\\s*(?:[^{}]*,\\s*)?${escapedSelector}(?:\\s*,[^{}]*)?\\s*\\{([^}]*)\\}`));
  return ruleMatch?.[1] ?? "";
}

function expectNoOuterPaddingOverride(css: string, selector: string): void {
  const ruleBlock = getCssRuleBlock(css, selector);
  expect(ruleBlock, `${selector} rule`).not.toBe("");
  expect(ruleBlock, `${selector} padding`).not.toMatch(/\bpadding(?:-[\w-]+)?\s*:/);
}

describe("TaskDetailModal CSS contract", () => {
  it("FN-4183 keeps detail source headers top-aligned so the disclosure toggle stays on the first row", async () => {
    const css = await loadAllAppCssBaseOnly();

    expect(css).toMatch(/\.detail-source-header\s*\{[^}]*align-items\s*:\s*flex-start\s*;/);
  });

  it("FN-5879/FN-6864 keeps the base detail tab strip horizontally scrollable and touch-pannable without shrinking tabs", async () => {
    const css = await loadAllAppCssBaseOnly();

    expect(css).toMatch(/\.detail-tabs\s*\{[^}]*overflow-x\s*:\s*auto\s*;/);
    expect(css).toMatch(/\.detail-tabs\s*\{[^}]*touch-action\s*:\s*pan-x\s+pan-y\s*;/);
    expect(css).toMatch(/\.detail-tab\s*\{[^}]*flex-shrink\s*:\s*0\s*;/);
  });

  /*
  FNXC:TaskDetailPadding 2026-08-01-03:20:
  FN-8634 moved the canonical tab inset from the scrolling `.detail-body` to its
  `.detail-body-content` child so scrollbar tracks remain outside the content inset.
  FN-7408 must assert that visual contract at the owning element while chat and
  planner variants remain forbidden from introducing competing outer padding.
  */
  it("FN-7408 keeps task-detail tab body padding canonical across Activity, planner Chat, and Plan surfaces", async () => {
    const css = await loadAllAppCssBaseOnly();
    const detailBodyContentBlock = getCssRuleBlock(css, ".detail-body-content");
    const rawBodyBlock = getCssRuleBlock(css, ".detail-body--agent-log");
    const planBlock = getCssRuleBlock(css, ".detail-section--plan-prompt");

    expect(detailBodyContentBlock).toContain("padding: calc(var(--space-lg) + var(--space-xs));");
    expectNoOuterPaddingOverride(css, ".detail-body--chat");
    expectNoOuterPaddingOverride(css, ".detail-body--planner-chat");
    expectNoOuterPaddingOverride(css, ".task-detail-content--chat-expanded .detail-body--chat");
    expectNoOuterPaddingOverride(css, ".task-detail-content--planner-chat-expanded .detail-body--planner-chat");
    expect(rawBodyBlock).not.toMatch(/\bpadding(?:-[\w-]+)?\s*:/);
    expect(planBlock).toContain("width: 100%;");
    expect(planBlock).toContain("max-width: 100%;");
  });

  /*
  FNXC:TaskDetailActivity 2026-07-27-02:15:
  FN-8624 extends FN-8166's symmetric Activity container inset from mobile to
  desktop and tablet. Only possible overlay-covered first rows may reserve tokenized
  clearance, so modal, pop-out, and embedded task-detail renders share this CSS contract.
  */
  it("FN-8624 keeps Activity container insets symmetric while clearing the overlay from first rows", async () => {
    const css = await loadAllAppCss();
    const baseCss = await loadAllAppCssBaseOnly();
    const mobileCss = css.slice(css.indexOf("@media (max-width: 768px)"));
    const firstRowSelectors = [
      ".detail-activity:not(.detail-activity--interventions) > h4",
      ".detail-activity:not(.detail-activity--interventions) > .detail-log-truncated",
      ".detail-activity:not(.detail-activity--interventions) > .detail-log-loading",
      ".detail-activity:not(.detail-activity--interventions) > .detail-log-empty",
      ".detail-activity:not(.detail-activity--interventions) > .detail-activity-list > .detail-log-entry:first-child",
    ];

    expect(baseCss).toContain(".detail-activity {\n  position: relative;\n  padding-inline-end: 0;\n}");
    expect(baseCss).toContain(".detail-activity--interventions {\n  padding-inline-end: 0;\n}");
    expect(baseCss).not.toContain(".detail-activity {\n  position: relative;\n  padding-inline-end: calc(var(--space-2xl) + var(--space-md));\n}");
    expect(mobileCss).not.toContain("  .detail-activity {\n    padding-inline-end:");
    for (const selector of firstRowSelectors) {
      const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(baseCss, selector).toMatch(new RegExp(`${escapedSelector}(?:\\s*,\\s*[^{}]+)*\\s*\\{[^}]*padding-inline-end: calc\\(var\\(--space-2xl\\) \\+ var\\(--space-md\\)\\);`));
      expect(mobileCss, selector).toMatch(new RegExp(`${escapedSelector}(?:\\s*,\\s*[^{}]+)*\\s*\\{[^}]*padding-inline-end: calc\\(var\\(--space-2xl\\) \\+ var\\(--space-sm\\)\\);`));
    }
  });

  it("FN-7351/FN-7375 keeps the Activity tab dropdown portal-safe on narrow task-detail surfaces", async () => {
    const css = await loadAllAppCssBaseOnly();
    const fullCss = await loadAllAppCss();

    expect(css).toMatch(/\.detail-tab-dropdown\s*\{[^}]*flex-shrink\s*:\s*0\s*;/);
    expect(css).toMatch(/\.detail-tab--activity\s*\{[^}]*display\s*:\s*inline-flex\s*;/);
    expect(css).toMatch(/\.activity-view-menu\s*\{[^}]*position\s*:\s*fixed\s*;/);
    expect(css).toMatch(/\.activity-view-menu\s*\{[^}]*z-index\s*:\s*1000\s*;/);
    expect(css).toMatch(/\.activity-view-menu\s*\{[^}]*overflow-y\s*:\s*auto\s*;/);
    expect(css).toMatch(/\.activity-view-menu\s*\{[^}]*overscroll-behavior\s*:\s*contain\s*;/);
    expect(fullCss).toMatch(
      /@media\s*\(max-width:\s*768px\)\s*\{[^}]*\.activity-view-menu\s*\{[^}]*max-inline-size\s*:\s*calc\(100vw - \(var\(--space-md\) \* 2\)\)\s*;/,
    );
    expect(css).not.toMatch(/\.activity-view-menu\s*\{[^}]*position\s*:\s*absolute\s*;/);
    expect(css).not.toMatch(/\.activity-view-menu\s*\{[^}]*inset-(?:block|inline)-start\s*:/);
    expect(css).not.toMatch(/\.activity-view-menu\s*\{[^}]*min-inline-size\s*:\s*100%\s*;/);
    expect(css).not.toContain(".activity-view-select");
    expect(css).not.toContain(".activity-segmented-control");
    expect(css).not.toContain(".activity-segment");
    expect(css).not.toContain(".log-subview-toggle");
    expect(css).not.toContain(".log-subview-btn");
  });
});
