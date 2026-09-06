/*
FNXC:TaskDetailTabs 2026-06-17-08:20:
FN-7306 labels the stable internal `chat` tab as Activity and keeps it as the default TaskDetailModal tab. Tests that assert Definition-only sections must opt into `initialTab="definition"` so they verify the intended surface instead of the Activity landing state.
*/
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  mockConfirm,
  mockConfirmWithChoice,
  mockConfirmWithCheckbox,
  mockUsePluginUiSlots,
  expectBaseRule,
  getCssRuleBlock,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal, TaskDetailContent } from "../TaskDetailModal";
import { FloatingWindow } from "../FloatingWindow";
import {
  assertModalGeometryRecoveryAndSheetContracts,
  assertRenderedModalTouchGeometry,
} from "./floatingWindowMigration.test-helpers";

setupTaskDetailModalHooks();

/*
FNXC:TaskDetailTabs 2026-07-07-15:00:
The rule-block extractors below match first-closing-brace structure, so a CSS comment
containing literal braces (e.g. TaskPlannerChatTab.css's FN-7634 note quoting
`.chat-input-row { … }`) truncates the extracted block and fails assertions against
declarations that ARE present. Neutralize ONLY braces inside comments (same-length
replacement) so structural matching is brace-safe while comment text, offsets, and the
"only-whitespace-between-} -and-selector" anchor semantics all stay intact.
*/
function neutralizeCssCommentBraces(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[{}]/g, " "));
}

function getCssAtRuleBlock(css: string, atRule: string, startAt = 0): { block: string; endIndex: number } {
  const atRuleStart = css.indexOf(atRule, startAt);
  expect(atRuleStart).toBeGreaterThanOrEqual(0);
  const openingBrace = css.indexOf("{", atRuleStart);
  expect(openingBrace).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = openingBrace; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return { block: css.slice(openingBrace + 1, index), endIndex: index + 1 };
    }
  }

  throw new Error(`Missing closing brace for ${atRule}`);
}

function getCssAtRuleBlockContaining(css: string, atRule: string, selector: string): string {
  let startAt = 0;
  while (startAt < css.length) {
    const { block, endIndex } = getCssAtRuleBlock(css, atRule, startAt);
    if (block.includes(selector)) {
      return block;
    }
    startAt = endIndex;
  }

  throw new Error(`Missing ${atRule} block containing ${selector}`);
}

function getCssAtRuleBlocks(css: string, atRule: string): string[] {
  const blocks: string[] = [];
  let startAt = 0;
  while (css.indexOf(atRule, startAt) >= 0) {
    const { block, endIndex } = getCssAtRuleBlock(css, atRule, startAt);
    blocks.push(block);
    startAt = endIndex;
  }
  return blocks;
}

function getExactCssRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ruleMatch = neutralizeCssCommentBraces(css).match(new RegExp(`(?:^|[}\\n])\\s*${escapedSelector}\\s*\\{([^}]*)\\}`));
  return ruleMatch?.[1] ?? "";
}

function getStandaloneCssRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ruleMatch = neutralizeCssCommentBraces(css).match(new RegExp(`(?:^|})\\s*${escapedSelector}\\s*\\{([^}]*)\\}`));
  return ruleMatch?.[1] ?? "";
}

function getCssAtRuleBlockContainingExactRule(css: string, atRule: string, selector: string): string {
  let startAt = 0;
  while (startAt < css.length) {
    const { block, endIndex } = getCssAtRuleBlock(css, atRule, startAt);
    if (getExactCssRuleBlock(block, selector)) {
      return block;
    }
    startAt = endIndex;
  }

  throw new Error(`Missing ${atRule} block containing exact ${selector}`);
}

function expectHorizontalTabScroller(ruleBlock: string, surface: string): void {
  expect(ruleBlock, `${surface} overflow-x`).toContain("overflow-x: auto;");
  expect(ruleBlock, `${surface} overflow-y`).toContain("overflow-y: hidden;");
  expect(ruleBlock, `${surface} overscroll`).toContain("overscroll-behavior-inline: contain;");
  expect(ruleBlock, `${surface} touch-action`).toContain("touch-action: pan-x pan-y;");
  expect(ruleBlock, `${surface} momentum-scroll`).toContain("-webkit-overflow-scrolling: touch;");
}

function expectTabTouchAction(ruleBlock: string, surface: string): void {
  expect(ruleBlock, `${surface} touch-action`).toContain("touch-action: pan-x pan-y;");
}

function expectNoSpacingOverrides(ruleBlock: string, surface: string): void {
  expect(ruleBlock, `${surface} padding`).not.toMatch(/\bpadding(?:-[\w-]+)?:/);
  expect(ruleBlock, `${surface} margin`).not.toMatch(/\bmargin(?:-[\w-]+)?:/);
  expect(ruleBlock, `${surface} gap`).not.toMatch(/(?:^|\s)gap:/);
}

describe("TaskDetailModal", () => {
  describe("mobile responsive structure", () => {
    it("keeps planner chat composer usable on narrow task-detail layouts", () => {
      const css = readDashboardStylesSource();
      const modelBlock = getExactCssRuleBlock(css, ".task-planner-chat-empty-model");
      const expandOverlayBlock = getExactCssRuleBlock(css, ".task-planner-chat-expand-toggle--overlay");
      const composerBlock = getExactCssRuleBlock(css, ".task-planner-chat-composer");
      const inputBlock = getExactCssRuleBlock(css, ".task-planner-chat-input");
      const mobileBlock = getCssAtRuleBlockContaining(css, "@media (max-width: 768px)", ".task-planner-chat-composer");
      const mobileComposerBlock = getCssRuleBlock(mobileBlock, ".task-planner-chat-composer");
      const mobileInputBlock = getCssRuleBlock(mobileBlock, ".task-planner-chat-input");
      const mobileSendBlock = getCssRuleBlock(mobileBlock, ".task-planner-chat-send");

      expectBaseRule(css, ".task-planner-chat", "display: flex;");
      expectBaseRule(css, ".task-planner-chat", "position: relative;");
      expectBaseRule(css, ".task-planner-chat", "min-height: 0;");
      expectBaseRule(css, ".task-planner-chat-transcript", "overflow: auto;");
      expectBaseRule(css, ".task-planner-chat-transcript", "min-height: 0;");
      expect(expandOverlayBlock).toContain("position: absolute;");
      expect(expandOverlayBlock).toContain("top: var(--space-sm);");
      expect(expandOverlayBlock).toContain("right: var(--space-sm);");
      expect(css).not.toContain(".task-planner-chat-header");
      expect(modelBlock).toContain("display: inline-flex;");
      expect(modelBlock).toContain("position: absolute;");
      expect(modelBlock).toContain("top: 0;");
      expect(modelBlock).toContain("left: 0;");
      expect(modelBlock).toContain("inline-size: calc(var(--space-2xl) - var(--space-xs));");
      expect(modelBlock).not.toContain("text-overflow: ellipsis;");
      expect(css).toMatch(/\.task-planner-chat-empty\s*\{[^}]*margin:\s*0 auto auto;/);
      expect(composerBlock).toContain("position: relative;");
      expect(composerBlock).toContain("display: flex;");
      expect(composerBlock).toContain("flex-wrap: wrap;");
      expect(composerBlock).toContain("align-items: stretch;");
      expect(composerBlock).toContain("flex: 0 0 auto;");
      expect(composerBlock).not.toContain("flex-direction: column;");
      expect(inputBlock).toContain("height: calc(var(--space-2xl) + var(--space-sm));");
      expect(inputBlock).toContain("min-height: calc(var(--space-2xl) + var(--space-sm));");
      expect(inputBlock).not.toContain("min-height: 5rem;");
      expect(mobileComposerBlock).toContain("flex-direction: row;");
      expect(mobileComposerBlock).toContain("flex-wrap: wrap;");
      expect(css).not.toContain(".task-planner-chat-target-controls");
      expect(css).not.toMatch(/\.task-planner-chat-composer \.chat-thinking-popover\s*\{/);
      expect(css).toMatch(/\.chat-thinking-popover\s*\{[^}]*position:\s*fixed;/);
      expect(mobileComposerBlock).toContain("align-items: flex-end;");
      /*
      FNXC:ChatComposerHeight 2026-08-23-20:15:
      FN-024 made every chat composer autosize through five lines in JS, so the narrow Planner
      composer keeps only its one-line floor and explicitly drops the fixed CSS cap
      (`max-height: none`); manual resizing stays desktop/tablet-only.
      */
      expect(mobileInputBlock).toContain("min-height: calc(var(--space-2xl) + var(--space-lg));");
      expect(mobileInputBlock).toContain("max-height: none;");
      expect(mobileInputBlock).toContain("resize: none;");
      expect(mobileSendBlock).toContain("justify-content: center;");
      expect(mobileSendBlock).toContain("inline-size: calc(var(--space-2xl) + var(--space-lg));");
      expect(mobileSendBlock).toContain("min-block-size: calc(var(--space-2xl) + var(--space-lg));");
      expectBaseRule(css, ".task-planner-chat-starters", "grid-template-columns: repeat(2, minmax(0, 1fr));");
      expectBaseRule(css, ".task-planner-chat .chat-question-response", "overflow-wrap: anywhere;");
      expect(mobileBlock).toContain(".task-planner-chat-starters");
      expect(mobileBlock).toContain("grid-template-columns: 1fr;");
      expect(mobileBlock).toContain(".task-planner-chat .chat-question-response");
      expect(mobileBlock).toContain("margin-inline: 0;");

      const detailCss = readDashboardStylesSource();
      expectBaseRule(detailCss, ".detail-body--planner-chat", "overflow-y: hidden;");
      expectBaseRule(detailCss, ".detail-section--planner-chat", "min-height: 0;");
      expect(detailCss).toContain(".task-detail-content--planner-chat-expanded .modal-actions");
      expect(detailCss).toContain(".task-detail-content--planner-chat-expanded .detail-tabs");
      expect(detailCss).toContain(".task-detail-content--planner-chat-expanded .detail-overseer-explain-panel");
      expect(detailCss).not.toContain(".task-detail-content--planner-chat-expanded .detail-meta");
      expect(detailCss).not.toContain(".task-detail-content--planner-chat-expanded .detail-provenance");
      expect(detailCss).not.toContain(".task-detail-content--planner-chat-expanded .detail-timestamps");
    });

    it("keeps task-detail outer padding canonical while Planner Chat owns only internal spacing", () => {
      const css = readDashboardStylesSource();
      const paddingContractStart = css.indexOf("Task-detail tabs share the `.detail-body` outer content inset");
      expect(paddingContractStart).toBeGreaterThanOrEqual(0);
      const detailBodyBlock = getExactCssRuleBlock(css, ".detail-body");
      const activityBodyBlock = getCssRuleBlock(css, ".detail-body--chat");
      const plannerBodyBlock = getCssRuleBlock(css, ".detail-body--planner-chat");
      const plannerPanelBlock = getExactCssRuleBlock(css, ".task-planner-chat");
      const plannerTranscriptBlock = getExactCssRuleBlock(css, ".task-planner-chat-transcript");
      const plannerComposerBlock = getExactCssRuleBlock(css, ".task-planner-chat-composer");
      const expandedPlannerBodyBlock = getExactCssRuleBlock(css, ".task-detail-content--planner-chat-expanded .detail-body--planner-chat");
      const expandedPlannerSectionBlock = getExactCssRuleBlock(css, ".task-detail-content--planner-chat-expanded .detail-section--planner-chat");
      const mobileBodyBlock = getCssAtRuleBlockContainingExactRule(css, "@media (max-width: 768px)", ".detail-body");
      const mobileDetailBodyBlock = getExactCssRuleBlock(mobileBodyBlock, ".detail-body");
      const detailBodyContentBlock = getExactCssRuleBlock(css, ".detail-body-content");
      const mobileDetailBodyContentBlock = getExactCssRuleBlock(mobileBodyBlock, ".detail-body-content");
      const mobilePlannerBlock = getCssAtRuleBlockContaining(css, "@media (max-width: 768px)", ".detail-body--chat");
      const mobilePlannerBodyBlock = getStandaloneCssRuleBlock(mobilePlannerBlock, ".detail-body--planner-chat");
      const mobileExpandedPlannerBodyBlock = getExactCssRuleBlock(mobilePlannerBlock, ".task-detail-content--planner-chat-expanded .detail-body--planner-chat");

      expect(detailBodyBlock).toContain("padding: 0;");
      expect(detailBodyContentBlock).toContain("padding: calc(var(--space-lg) + var(--space-xs));");
      expect(mobileDetailBodyBlock).toContain("padding: 0;");
      expect(mobileDetailBodyContentBlock).toContain("padding: calc(var(--space-md) + var(--space-xs) / 2);");
      expectNoSpacingOverrides(activityBodyBlock, "desktop Activity body modifier");
      expectNoSpacingOverrides(plannerBodyBlock, "desktop planner body modifier");
      expect(expandedPlannerBodyBlock).toContain("flex: 1;");
      expect(expandedPlannerBodyBlock).toContain("min-height: 0;");
      expectNoSpacingOverrides(expandedPlannerBodyBlock, "desktop expanded planner body");
      expect(expandedPlannerSectionBlock).toContain("flex: 1;");
      expect(expandedPlannerSectionBlock).toContain("min-height: 0;");
      expectNoSpacingOverrides(expandedPlannerSectionBlock, "desktop expanded planner section");
      expect(mobilePlannerBodyBlock).toBe("");
      expect(mobileExpandedPlannerBodyBlock).toBe("");
      expect(plannerPanelBlock).toContain("gap: var(--space-md);");
      expect(plannerTranscriptBlock).toContain("padding: var(--space-md);");
      expect(plannerTranscriptBlock).toContain("gap: var(--space-md);");
      expect(plannerComposerBlock).toContain("gap: var(--space-sm);");
      expect(css).not.toMatch(/task-detail-content--planner-chat-expanded[^{]+\.(?:task-planner-chat|task-planner-chat-transcript|task-planner-chat-composer)\s*\{[^}]*(?:padding|margin|gap)\s*:/);
      expect(css).not.toMatch(/task-detail-content--planner-chat-expanded[^{]+\.detail-body--planner-chat\s*\{[^}]*(?:padding|margin|gap)\s*:/);
    });

    it("keeps grouped timestamp metadata inline on desktop and mobile", () => {
      const css = readDashboardStylesSource();

      expectBaseRule(css, ".detail-timestamps", "display: inline-flex;");
      expectBaseRule(css, ".detail-timestamps", "flex-wrap: nowrap;");
      expectBaseRule(css, ".detail-timestamp-item", "display: inline-flex;");
      expectBaseRule(css, ".detail-timestamp-separator", "color: var(--text-dim);");

      expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.detail-timestamps\s*\{[^}]*align-items:\s*center;[^}]*flex-wrap:\s*nowrap;/);
      expect(css).not.toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.detail-timestamps\s*\{[^}]*flex-direction:\s*column;/);
      expect(css).not.toContain(".task-detail-content--planner-chat-expanded .detail-timestamps");
    });

    it("keeps the canonical workflow badge owned by the timestamp group across breakpoints", () => {
      const css = readDashboardStylesSource();
      const workflowBadgeBlock = css.match(/^\.detail-workflow-badge\s*\{([^}]*)\}/m)?.[1] ?? "";
      const mobileBlock = getCssAtRuleBlockContaining(css, "@media (max-width: 768px)", ".detail-timestamps");
      const mobileTimestampsBlock = getCssRuleBlock(mobileBlock, ".detail-timestamps");

      expect(workflowBadgeBlock).toContain("display: inline-flex;");
      expect(workflowBadgeBlock).toContain("align-items: center;");
      expect(workflowBadgeBlock).toContain("column-gap: calc(var(--space-xs) / 2);");
      expect(workflowBadgeBlock).toContain("flex: 0 1 auto;");
      expect(workflowBadgeBlock).toContain("text-overflow: ellipsis;");
      expect(mobileTimestampsBlock).toContain("display: flex;");
      expect(mobileTimestampsBlock).toContain("align-items: center;");
      expect(mobileTimestampsBlock).toContain("flex-wrap: nowrap;");
      expect(css).not.toMatch(/detail-workflow-badge--desktop/);
      expect(css).not.toMatch(/detail-workflow-badge--mobile/);
      expect(css).not.toMatch(/task-detail-workflow-badge-mobile/);
      expect(css).not.toMatch(/\.detail-title-row\s+\.detail-workflow-badge\s*\{/);
    });
    it("uses FloatingWindow's full-screen sheet guards on phone and short viewports", () => {
      const css = readFileSync(resolve(__dirname, "../FloatingWindow.css"), "utf8");
      const sheetBlock = getCssAtRuleBlockContaining(css, "@media (max-width: 767.98px), (max-height: 480px)", ".floating-window--task-detail");
      const sheetRule = getCssRuleBlock(sheetBlock, ".floating-window--task-detail");

      expect(sheetRule).toContain("inset: 0 !important;");
      expect(sheetRule).toContain("width: 100vw !important;");
      expect(sheetRule).toContain("height: 100dvh !important;");
    });

    it("reconciles tablet overlay offset with task-detail max-height and widens the modal", () => {
      const css = readDashboardStylesSource();
      const tabletBlock = getCssAtRuleBlockContaining(css, "@media (min-width: 769px) and (max-width: 1024px)", ".modal.task-detail-modal");
      const tabletOverlayBlock = getCssRuleBlock(tabletBlock, ".modal-overlay:has(.task-detail-modal)");
      const tabletModalBlock = getCssRuleBlock(tabletBlock, ".modal.task-detail-modal");
      const overlayOffset = tabletOverlayBlock.match(/--overlay-padding-top:\s*([^;]+);/)?.[1]?.trim();
      const maxHeightOffset = tabletModalBlock.match(/max-height:\s*calc\(100dvh - var\(--overlay-padding-top,\s*([^)]+)\) - var\(--space-md\)\);/)?.[1]?.trim();

      expect(overlayOffset).toBeTruthy();
      expect(maxHeightOffset).toBe(overlayOffset);
      expect(tabletModalBlock).toContain("width: 98vw;");
      expect(tabletModalBlock).toContain("max-width: 98vw;");
      expect(tabletModalBlock).toContain("height: 92vh;");
      expect(tabletModalBlock).not.toContain("width: min(96vw, 1024px);");
      expect(tabletModalBlock).not.toContain("16px");
    });

    it("keeps Plan prompt surfaces full-width across modal, embedded, and mobile task-detail layouts", () => {
      const css = readDashboardStylesSource();
      const planBlock = getExactCssRuleBlock(css, ".detail-section--plan-prompt");
      const planSurfaceBlock = getExactCssRuleBlock(css, ".detail-section--plan-prompt .markdown-body,\n.detail-section--plan-prompt .detail-prompt,\n.detail-section--plan-prompt .spec-loading,\n.detail-section--plan-prompt .spec-editor-edit-mode,\n.detail-section--plan-prompt .spec-editor-revision,\n.detail-section--plan-prompt .spec-editor-textarea,\n.detail-section--plan-prompt .spec-editor-feedback");
      const embeddedPlanBlock = getExactCssRuleBlock(css, ".task-detail-content--embedded .detail-section--plan-prompt");
      const editModeBlock = getExactCssRuleBlock(css, ".spec-editor-edit-mode");
      const textareaBlock = getExactCssRuleBlock(css, ".spec-editor-textarea");
      const feedbackBlock = getExactCssRuleBlock(css, ".spec-editor-feedback");
      const actionsBlock = getExactCssRuleBlock(css, ".spec-editor-actions-row");
      const revisionActionsBlock = getExactCssRuleBlock(css, ".spec-editor-revision-actions");
      const mobileBlock = getCssAtRuleBlockContaining(css, "@media (max-width: 768px)", ".detail-section--plan-prompt .spec-editor-actions-row");

      for (const [surface, block] of [
        ["Plan wrapper", planBlock],
        ["Plan prompt descendants", planSurfaceBlock],
        ["embedded Plan wrapper", embeddedPlanBlock],
        ["edit mode", editModeBlock],
        ["textarea", textareaBlock],
        ["feedback", feedbackBlock],
        ["save/cancel actions", actionsBlock],
        ["AI revision actions", revisionActionsBlock],
      ] as const) {
        expect(block, `${surface} width`).toContain("width: 100%;");
        expect(block, `${surface} min-width`).toContain("min-width: 0;");
        expect(block, `${surface} max-width`).toContain("max-width: 100%;");
      }

      expect(planBlock).toContain("display: flex;");
      expect(planBlock).toContain("flex-direction: column;");
      expect(planSurfaceBlock).toContain("box-sizing: border-box;");
      expect(textareaBlock).toContain("box-sizing: border-box;");
      expect(feedbackBlock).toContain("box-sizing: border-box;");
      expect(actionsBlock).toContain("flex-wrap: wrap;");
      expect(revisionActionsBlock).toContain("flex-wrap: wrap;");
      expect(mobileBlock).toContain(".detail-section--plan-prompt .spec-editor-actions-row,");
      expect(mobileBlock).toContain(".detail-section--plan-prompt .spec-editor-revision-actions");
      expect(mobileBlock).toContain("align-items: stretch;");
      expect(mobileBlock).toContain("flex-wrap: wrap;");
      expect(mobileBlock).toContain(".detail-section--plan-prompt .spec-editor-actions-row .btn,");
      expect(mobileBlock).toContain(".detail-section--plan-prompt .spec-editor-revision-actions .btn");
      expect(mobileBlock).toContain("flex: 1 1 auto;");
      expect(css).not.toMatch(/\.detail-section\s*\{[^}]*width:\s*100%;/);
    });

    it("keeps task-detail tabs as horizontal scrollers across modal, embedded, mobile, and tablet surfaces", () => {
      const css = readDashboardStylesSource();
      const baseTabsBlock = getExactCssRuleBlock(css, ".detail-tabs");
      const mobileBlock = getCssAtRuleBlockContainingExactRule(css, "@media (max-width: 768px)", ".detail-tabs");
      const mobileTabsBlock = getExactCssRuleBlock(mobileBlock, ".detail-tabs");
      const tabletBlock = getCssAtRuleBlockContainingExactRule(css, "@media (min-width: 769px) and (max-width: 1024px)", ".detail-tabs");
      const tabletTabsBlock = getExactCssRuleBlock(tabletBlock, ".detail-tabs");
      const embeddedTabsBlock = getExactCssRuleBlock(css, ".task-detail-content--embedded .detail-tabs");
      const detailContentBlock = getCssRuleBlock(css, ".task-detail-content");
      const detailBodyBlock = getCssRuleBlock(css, ".detail-body");
      const baseDetailTabsSection = css.slice(css.indexOf("/* === Detail Tabs === */"));
      const detailTabBlock = getExactCssRuleBlock(baseDetailTabsSection, ".detail-tab");
      const mobileTabBlock = getExactCssRuleBlock(mobileBlock, ".detail-tab");
      const tabletTabBlock = getExactCssRuleBlock(tabletBlock, ".detail-tab");
      const embeddedTabBlock = getExactCssRuleBlock(css, ".task-detail-content--embedded .detail-tab");

      expectHorizontalTabScroller(baseTabsBlock, "base .detail-tabs");
      expectHorizontalTabScroller(mobileTabsBlock, "mobile .detail-tabs");
      expectHorizontalTabScroller(tabletTabsBlock, "tablet .detail-tabs");
      expectHorizontalTabScroller(embeddedTabsBlock, "embedded .detail-tabs");
      expectTabTouchAction(detailTabBlock, "base .detail-tab");
      expectTabTouchAction(mobileTabBlock, "mobile .detail-tab");
      expectTabTouchAction(tabletTabBlock, "tablet .detail-tab");
      expectTabTouchAction(embeddedTabBlock, "embedded .detail-tab");
      expect(baseTabsBlock).toContain("min-width: 0;");
      expect(mobileTabsBlock).toContain("min-width: 0;");
      expect(detailTabBlock).toContain("flex-shrink: 0;");
      expect(detailContentBlock).toContain("min-height: 0;");
      expect(detailContentBlock).toContain("min-width: 0;");
      expect(detailBodyBlock).toContain("min-width: 0;");
      expect(detailBodyBlock).not.toContain("overflow-x: auto;");
      expect(detailBodyBlock).not.toContain("overflow: hidden;");
    });

    it("FN-8779: keeps the Feed flex chain bounded while the shared footer remains outside it on every Task Detail host", () => {
      const css = readDashboardStylesSource();
      const rootBlock = getExactCssRuleBlock(css, ".task-detail-content");
      const detailBodyBlock = getExactCssRuleBlock(css, ".detail-body");
      const feedBodyBlock = getExactCssRuleBlock(css, ".detail-body--feed,\n.detail-body--agent-log");
      const feedContentBlock = getExactCssRuleBlock(
        css,
        ".detail-body--feed > .detail-body-content,\n.detail-body--agent-log > .detail-body-content,\n.detail-body--chat > .detail-body-content,\n.detail-body--planner-chat > .detail-body-content",
      );
      const feedSectionBlock = getExactCssRuleBlock(css, ".detail-section--feed,\n.detail-section--agent-log");
      const feedActivityBlock = getExactCssRuleBlock(css, ".detail-section--feed > .detail-activity");
      const feedListBlock = getExactCssRuleBlock(css, ".detail-section--feed .detail-activity-list");
      const footerBlock = getExactCssRuleBlock(css, ".task-detail-content > .modal-actions");
      const mobileBlock = getCssAtRuleBlockContainingExactRule(css, "@media (max-width: 768px)", ".detail-body");
      const mobileDetailBodyBlock = getExactCssRuleBlock(mobileBlock, ".detail-body");
      const embeddedBlock = getExactCssRuleBlock(
        css,
        ".task-detail-content--embedded .modal-header,\n.task-detail-content--embedded .detail-body,\n.task-detail-content--embedded .detail-tabs,\n.task-detail-content--embedded .modal-actions",
      );

      expect(rootBlock).toContain("height: 100%;");
      expect(rootBlock).toContain("min-height: 0;");
      expect(detailBodyBlock).toContain("flex: 1;");
      expect(detailBodyBlock).toContain("min-height: 0;");
      expect(feedBodyBlock).toContain("display: flex;");
      expect(feedBodyBlock).toContain("flex-direction: column;");
      expect(feedBodyBlock).toContain("min-height: 0;");
      expect(feedBodyBlock).toContain("overflow-y: hidden;");
      expect(feedContentBlock).toContain("flex: 1;");
      expect(feedContentBlock).toContain("min-height: 0;");
      expect(feedSectionBlock).toContain("flex: 1;");
      expect(feedSectionBlock).toContain("min-height: 0;");
      expect(feedActivityBlock).toContain("flex: 1;");
      expect(feedActivityBlock).toContain("min-height: 0;");
      expect(feedListBlock).toContain("flex: 1;");
      expect(feedListBlock).toContain("min-height: 0;");
      expect(feedListBlock).toContain("overflow-y: auto;");
      expect(footerBlock).toContain("flex: 0 0 auto;");
      expect(mobileDetailBodyBlock).toContain("min-height: 0;");
      expect(mobileDetailBodyBlock).toContain("overflow-y: auto;");
      expect(embeddedBlock).toContain("width: 100%;");
      expect(embeddedBlock).toContain("min-width: 0;");
      expect(embeddedBlock).toContain("max-width: 100%;");
    });

    it("keeps the Activity tab dropdown portal-safe and reachable on mobile", () => {
      const css = readDashboardStylesSource();
      const tabDropdownBlock = getExactCssRuleBlock(css, ".detail-tab-dropdown");
      const activityTabBlock = getExactCssRuleBlock(css, ".detail-tab--activity");
      const menuBlock = getExactCssRuleBlock(css, ".activity-view-menu");
      const mobileBlock = getCssAtRuleBlockContainingExactRule(css, "@media (max-width: 768px)", ".activity-view-menu");
      const mobileMenuBlock = getExactCssRuleBlock(mobileBlock, ".activity-view-menu");

      expect(tabDropdownBlock).toContain("position: relative;");
      expect(tabDropdownBlock).toContain("flex-shrink: 0;");
      expect(activityTabBlock).toContain("display: inline-flex;");
      expect(activityTabBlock).toContain("gap: var(--space-xs);");
      expect(menuBlock).toContain("position: fixed;");
      expect(menuBlock).toContain("z-index: 1000;");
      expect(menuBlock).toContain("padding: var(--space-xs);");
      expect(menuBlock).toContain("overflow-y: auto;");
      expect(menuBlock).not.toContain("position: absolute;");
      expect(menuBlock).not.toContain("inset-block-start");
      expect(menuBlock).not.toContain("inset-inline-start");
      expect(menuBlock).not.toContain("min-inline-size: 100%;");
      expect(mobileMenuBlock).toContain("max-inline-size: calc(100vw - (var(--space-md) * 2));");
      expect(css).not.toContain(".activity-view-select");
      expect(css).not.toContain(".activity-segmented-control");
      expect(css).not.toContain(".activity-segment");
    });

    it("keeps Activity Live/Feed expand controls overlaid without a mobile toolbar row", () => {
      const css = readDashboardStylesSource();
      const overlayBlock = getExactCssRuleBlock(css, ".activity-expand-toggle--overlay");
      const mobileBlock = getCssAtRuleBlockContainingExactRule(css, "@media (max-width: 768px)", ".activity-expand-toggle--overlay");
      const mobileOverlayBlock = getExactCssRuleBlock(mobileBlock, ".activity-expand-toggle--overlay");

      expect(css).not.toContain(".activity-toolbar");
      expect(css).not.toContain("activity-toolbar--expand-only");
      expect(css).toContain(".detail-activity {\n  position: relative;\n  padding-inline-end: 0;\n}");
      expect(css).toContain(".detail-activity:not(.detail-activity--interventions) > h4,");
      expect(css).toContain("padding-inline-end: calc(var(--space-2xl) + var(--space-md));");
      expect(overlayBlock).toContain("position: absolute;");
      expect(overlayBlock).toContain("top: var(--space-md);");
      expect(overlayBlock).toContain("right: var(--space-md);");
      expect(mobileBlock).not.toContain("  .detail-activity {\n    padding-inline-end:");
      expect(mobileOverlayBlock).toContain("top: var(--space-sm);");
      expect(mobileOverlayBlock).toContain("right: var(--space-sm);");

      /*
      FNXC:TaskDetailActivity 2026-07-27-02:15:
      FN-8624 requires Feed to inherit the symmetric `.detail-body` inset at every
      breakpoint, while only its first visible row reserves space for the opaque overlay.
      This contract covers modal, pop-out, embedded, and mobile task-detail surfaces.
      */
      const mobileDetailBodyBlock = getExactCssRuleBlock(mobileBlock, ".detail-body");
      const mobileDetailBodyContentBlock = getExactCssRuleBlock(mobileBlock, ".detail-body-content");
      const baseInterventionsBlock = getExactCssRuleBlock(css, ".detail-activity--interventions");
      const mobilePrBlock = getExactCssRuleBlock(
        getCssAtRuleBlockContainingExactRule(css, "@media (max-width: 768px)", ".detail-pr-tab"),
        ".detail-pr-tab",
      );
      const embeddedBodyBlock = getExactCssRuleBlock(
        css,
        ".task-detail-content--embedded .modal-header,\n.task-detail-content--embedded .detail-body,\n.task-detail-content--embedded .detail-tabs,\n.task-detail-content--embedded .modal-actions",
      );
      const allMobileCss = getCssAtRuleBlocks(css, "@media (max-width: 768px)").join("\n");

      expect(mobileDetailBodyBlock).toContain("padding: 0;");
      expect(mobileDetailBodyContentBlock).toContain("padding: calc(var(--space-md) + var(--space-xs) / 2);");
      expect(mobileDetailBodyBlock).toContain("overflow-x: hidden;");
      expect(baseInterventionsBlock).toContain("padding-inline-end: 0;");
      expect(mobileBlock).toContain(".detail-activity:not(.detail-activity--interventions) > h4,");
      expect(mobileBlock).toContain(".detail-activity:not(.detail-activity--interventions) > .detail-log-loading,");
      expect(mobileBlock).toContain(".detail-activity:not(.detail-activity--interventions) > .detail-log-empty,");
      expect(mobileBlock).toContain(".detail-activity:not(.detail-activity--interventions) > .detail-activity-list > .detail-log-entry:first-child");
      expect(mobileBlock).toContain("padding-inline-end: calc(var(--space-2xl) + var(--space-sm));");
      expect(mobilePrBlock.trim()).toBe("gap: var(--space-md);");
      expect(embeddedBodyBlock).toContain("width: 100%;");
      expect(embeddedBodyBlock).toContain("min-width: 0;");
      expect(embeddedBodyBlock).toContain("max-width: 100%;");
      expect(allMobileCss).not.toMatch(/\.task-changes-tab\s*\{[^}]*\bpadding(?:-[\w-]+)?\s*:/);

      for (const selector of [
        ".detail-section",
        ".detail-section--plan-prompt",
        ".detail-section--original-prompt",
        ".detail-body--chat",
        ".detail-section--chat",
        ".detail-body--agent-log",
      ]) {
        const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const exactSelector = `${escapedSelector}(?![-\\w])`;
        const declarations = [...neutralizeCssCommentBraces(allMobileCss).matchAll(new RegExp(`${exactSelector}[^{}]*\\{([^{}]*)\\}`, "g"))]
          .map((match) => match[1])
          .join("\n");
        expect(declarations, `${selector} mobile right inset`).not.toMatch(/\bpadding-(?:inline-end|right)\s*:/);
        expect(declarations, `${selector} mobile asymmetric padding`).not.toMatch(/\bpadding\s*:/);
      }
    });

    it("FN-8189 hides only the mobile detail-body scrollbar to preserve symmetric task-detail insets", () => {
      const css = readDashboardStylesSource();
      const baseDetailBodyBlock = getExactCssRuleBlock(css, ".detail-body");
      const baseScrollbarBlock = getExactCssRuleBlock(css, ".detail-body::-webkit-scrollbar");
      const mobileBlock = getCssAtRuleBlockContainingExactRule(css, "@media (max-width: 768px)", ".detail-body");
      const mobileDetailBodyBlock = getExactCssRuleBlock(mobileBlock, ".detail-body");
      const mobileDetailBodyContentBlock = getExactCssRuleBlock(mobileBlock, ".detail-body-content");
      const mobileScrollbarBlock = getExactCssRuleBlock(mobileBlock, ".detail-body::-webkit-scrollbar");
      const mobileActivityBlock = getExactCssRuleBlock(mobileBlock, ".detail-activity");
      const mobileInterventionsBlock = getExactCssRuleBlock(mobileBlock, ".detail-activity--interventions");
      const baseInterventionsBlock = getExactCssRuleBlock(css, ".detail-activity--interventions");
      const mobilePrBlock = getExactCssRuleBlock(
        getCssAtRuleBlockContainingExactRule(css, "@media (max-width: 768px)", ".detail-pr-tab"),
        ".detail-pr-tab",
      );
      const embeddedBodyBlock = getExactCssRuleBlock(
        css,
        ".task-detail-content--embedded .modal-header,\n.task-detail-content--embedded .detail-body,\n.task-detail-content--embedded .detail-tabs,\n.task-detail-content--embedded .modal-actions",
      );
      const allMobileCss = getCssAtRuleBlocks(css, "@media (max-width: 768px)").join("\n");

      expect(baseDetailBodyBlock).toContain("scrollbar-width: thin;");
      expect(baseScrollbarBlock).toContain("width: 6px;");
      expect(mobileDetailBodyBlock).toContain("padding: 0;");
      expect(mobileDetailBodyContentBlock).toContain("padding: calc(var(--space-md) + var(--space-xs) / 2);");
      expect(mobileDetailBodyBlock).toContain("overflow-x: hidden;");
      expect(mobileDetailBodyBlock).toContain("overflow-y: auto;");
      expect(mobileDetailBodyBlock).toContain("scrollbar-width: none;");
      expect(mobileScrollbarBlock).toContain("display: none;");

      expect(mobileActivityBlock).toBe("");
      expect(mobileBlock).toContain("padding-inline-end: calc(var(--space-2xl) + var(--space-sm));");
      expect(mobileInterventionsBlock).toBe("");
      expect(baseInterventionsBlock).toContain("padding-inline-end: 0;");
      expect(mobilePrBlock.trim()).toBe("gap: var(--space-md);");
      expect(allMobileCss).not.toMatch(/\.task-changes-tab\s*\{[^}]*\bpadding(?:-[\w-]+)?\s*:/);
      expect(embeddedBodyBlock).toContain("width: 100%;");
      expect(embeddedBodyBlock).toContain("min-width: 0;");
      expect(embeddedBodyBlock).toContain("max-width: 100%;");

      for (const selector of [
        ".detail-section",
        ".detail-section--plan-prompt",
        ".detail-section--original-prompt",
        ".detail-body--chat",
        ".detail-section--chat",
        ".detail-body--agent-log",
        ".detail-body--planner-chat",
      ]) {
        const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const exactSelector = `${escapedSelector}(?![-\\w])`;
        const declarations = [...neutralizeCssCommentBraces(allMobileCss).matchAll(new RegExp(`${exactSelector}[^{}]*\\{([^{}]*)\\}`, "g"))]
          .map((match) => match[1])
          .join("\n");
        expect(declarations, `${selector} mobile right inset`).not.toMatch(/\bpadding-(?:inline-end|right)\s*:/);
        expect(declarations, `${selector} mobile asymmetric padding`).not.toMatch(/\bpadding\s*:/);
      }
    });

    it("keeps the floating task header symmetric without sacrificing its resize targets", () => {
      const floatingCss = readFileSync(resolve(__dirname, "../FloatingWindow.css"), "utf8");
      const desktopWindowSelector = ".floating-window:not(.floating-window--tablet-viewport)";
      const sharedBody = getExactCssRuleBlock(floatingCss, ".floating-window__body");
      const header = getExactCssRuleBlock(readDashboardStylesSource(), ".modal-header");
      const eastResize = getExactCssRuleBlock(floatingCss, `${desktopWindowSelector} .floating-window__resize-handle--e`);
      const cornerResize = floatingCss.match(
        /\.floating-window:not\(\.floating-window--tablet-viewport\) \.floating-window__resize-handle--ne,[\s\S]*?\}/
      )?.[0] ?? "";
      const onRequestClose = vi.fn();

      /*
      FNXC:TaskDetailLayout 2026-08-18-00:26:
      The shared body reserves NOTHING on its inline end any more — FN-8015's gutter is deleted for
      every caller, so this popup's symmetric edge no longer depends on a local zeroing that undoes
      it. FN-8766's outboard resize targets that make the scrollbar grabbable are likewise no longer
      task-detail-scoped: they are the shared desktop rule, and this popup inherits them.
      */
      expect(sharedBody).not.toMatch(/margin-inline-end\s*:/);
      expect(header).toContain("padding: var(--modal-padding);");
      expect(eastResize).toContain("right: calc(var(--space-sm) * -1);");
      expect(cornerResize).toContain("resize-handle--se");
      expect(cornerResize).toContain("right: calc(var(--space-lg) * -1);");

      const { baseElement, unmount } = render(
        <FloatingWindow
          windowKey="task-detail-inset"
          title="FN-8766"
          onClose={onRequestClose}
          hideHeader
          dragHandleSelector=".task-detail-content--embedded > .modal-header"
          className="floating-window--task-detail"
          layer="task-detail"
        >
          <TaskDetailContent
            task={makeTask({ id: "FN-8766", title: "A task title long enough to exercise header alignment" })}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
            embedded
            onRequestClose={onRequestClose}
          />
        </FloatingWindow>,
      );

      const popup = baseElement.querySelector("[data-testid='floating-window-task-detail-inset']");
      const close = screen.getByRole("button", { name: "Close" });
      expect(popup).toHaveClass("floating-window--task-detail");
      expect(popup?.querySelector(".task-detail-content--embedded > .modal-header")).toContainElement(close);
      expect(close).toHaveClass("task-detail-floating-close");
      expect(popup?.querySelectorAll(".floating-window__resize-handle")).toHaveLength(8);
      fireEvent.click(close);
      expect(onRequestClose).toHaveBeenCalledTimes(1);
      unmount();
    });

    it("uses production FloatingWindow geometry for touch drag, eight-direction resize, recovery, and sheets", () => {
      const mount = () => render(
        <TaskDetailModal
          task={makeTask({ column: "in-progress" as Column })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      const rendered = mount();
      const header = rendered.baseElement.querySelector("[data-testid='floating-window-task-detail'] .modal-header");
      expect(header).not.toBeNull();
      assertRenderedModalTouchGeometry("task-detail", header!);
      rendered.unmount();
      assertModalGeometryRecoveryAndSheetContracts("task-detail", mount);
    });

    it("keeps Task Detail resizable for a known touch tablet at 768px", () => {
      const originalScreen = Object.getOwnPropertyDescriptor(window, "screen");
      const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
      const originalMatchMedia = window.matchMedia;
      Object.defineProperty(window, "screen", { configurable: true, value: { width: 768, height: 1024 } });
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 1 });
      vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
        matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })));

      try {
        const { baseElement: container } = render(
          <TaskDetailModal
            task={makeTask({ column: "in-progress" as Column })}
            onClose={noop}
            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );
        const window = container.querySelector("[data-testid='floating-window-task-detail']");
        expect(window).toBeTruthy();
        const handles = window!.querySelectorAll(".floating-window__resize-handle");
        expect(handles).toHaveLength(8);
        handles.forEach((handle) => expect(handle).toHaveAttribute("data-resize-hit-target", "true"));
        expect(container.querySelector(".modal-resize-grip")).toBeNull();
      } finally {
        if (originalScreen) Object.defineProperty(window, "screen", originalScreen);
        if (originalMaxTouchPoints) Object.defineProperty(navigator, "maxTouchPoints", originalMaxTouchPoints);
        vi.stubGlobal("matchMedia", originalMatchMedia);
      }
    });

    it("renders responsive structural classes (modal-lg, overlay, spacer, tabs, detail-body)", () => {
      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ column: "in-progress" as Column })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      expect(container.querySelector(".modal.modal-lg")).toBeTruthy();
      expect(container.querySelector("[data-testid='floating-window-overlay-task-detail']")).toBeTruthy();
      expect(container.querySelector(".modal-actions .modal-actions-spacer")).toBeTruthy();
      expect(container.querySelector(".detail-body")).toBeTruthy();
      expect(container.querySelector(".detail-timestamps")).toBeTruthy();
      expect(container.querySelectorAll(".detail-timestamp-item").length).toBe(2);
      const tabs = container.querySelectorAll(".detail-tab");
      // FN-244 keeps the responsive strip aligned with the consolidated desktop inventory.
      expect(Array.from(tabs).map((tab) => tab.textContent?.trim())).toEqual([
        "Activity",
        "Chat",
        "Plan",
        "Changes",
        "Summary",
        "Stats",
        "Review",
        "Comments",
        "Dependencies",
        "Artifacts",
        "Model",
        "Workflow",
        "Details",
        "Terminal",
      ]);
      expect(screen.getByRole("button", { name: "Details" })).toHaveClass("detail-tab-active");
      expect(Array.from(tabs).filter((tab) => tab.classList.contains("detail-tab-active"))).toHaveLength(1);
      // Responsive CSS controls sizing — no inline padding/fontSize/borderBottom leaks
      expect((tabs[0] as HTMLElement).style.padding).toBe("");
      expect((tabs[0] as HTMLElement).style.fontSize).toBe("");
      expect((container.querySelector(".detail-tabs") as HTMLElement).style.borderBottom).toBe("");
    });

    it("keeps every mobile task footer control shrinkable on one row from 320 CSS px through 768px", () => {
      const css = readDashboardStylesSource();
      const mobileBlock = getCssAtRuleBlockContainingExactRule(css, "@media (max-width: 768px)", ".task-detail-content .modal-actions");
      const footerBlock = getExactCssRuleBlock(mobileBlock, ".task-detail-content .modal-actions");
      const spacerBlock = getExactCssRuleBlock(mobileBlock, ".task-detail-content .modal-actions-spacer");
      const buttonBlock = getExactCssRuleBlock(mobileBlock, ".task-detail-content .modal-actions .btn");
      const labelBlock = getExactCssRuleBlock(mobileBlock, ".task-detail-content .detail-footer-button-label");
      const dropdownBlock = getExactCssRuleBlock(mobileBlock, ".task-detail-content .detail-actions-dropdown");
      const expandedChatBlock = getExactCssRuleBlock(css, ".task-detail-content--chat-expanded .modal-actions");

      /*
      FNXC:TaskDetailModalResponsive 2026-07-22-00:00:
      FN-8492's supported mobile fit contract is 320 CSS px through 768px. Keep
      these source assertions together: `nowrap` without shrink guards and
      text ellipsis would merely turn the original second row into overflow.
      */
      expect(footerBlock).toContain("flex-wrap: nowrap;");
      expect(footerBlock).not.toContain("flex-wrap: wrap;");
      expect(footerBlock).toContain("align-items: center;");
      expect(footerBlock).toContain("gap: var(--space-xs);");
      expect(spacerBlock).toContain("flex: 1 1 0;");
      expect(spacerBlock).toContain("min-width: 0;");
      expect(dropdownBlock).toContain("min-width: 0;");
      expect(dropdownBlock).toContain("flex-shrink: 1;");
      expect(css).not.toContain(".detail-move-");
      expect(buttonBlock).toContain("flex: 0 1 auto;");
      expect(buttonBlock).toContain("min-width: 0;");
      expect(buttonBlock).toContain("padding-inline: var(--space-xs);");
      expect(buttonBlock).toContain("white-space: nowrap;");
      expect(buttonBlock).toContain("overflow: hidden;");
      expect(buttonBlock).toContain("text-overflow: ellipsis;");
      expect(labelBlock).toContain("min-width: 0;");
      expect(labelBlock).toContain("white-space: nowrap;");
      expect(labelBlock).toContain("overflow: hidden;");
      expect(labelBlock).toContain("text-overflow: ellipsis;");
      expect(expandedChatBlock).toContain("display: none;");
      expect(css).toMatch(/\.task-detail-content--planner-chat-expanded \.modal-actions,[\s\S]*?\{\s*display:\s*none;/);
    });

    it("keeps dense in-review and standard task controls in their shared footer", () => {
      const { baseElement: container, unmount } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-review" as Column })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      const inReviewFooter = container.querySelector(".modal-actions");

      expect(inReviewFooter).toBeTruthy();
      expect(inReviewFooter?.contains(screen.getByRole("button", { name: "Actions" }))).toBe(true);
      expect(inReviewFooter?.contains(screen.getByRole("button", { name: "Merge & Close" }))).toBe(true);
      expect(inReviewFooter?.querySelector(".detail-move-dropdown, .detail-move-btn, .detail-move-menu")).toBeNull();

      unmount();

      const standard = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-progress" as Column })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      const standardFooter = standard.baseElement.querySelector(".modal-actions");

      expect(standardFooter).toBeTruthy();
      expect(standardFooter?.contains(screen.getByRole("button", { name: "Actions" }))).toBe(true);
      const footerChildren = Array.from(standardFooter?.children ?? []);
      const actionsIndex = footerChildren.findIndex((child) => child.classList.contains("detail-actions-dropdown"));
      const spacerIndex = footerChildren.findIndex((child) => child.classList.contains("modal-actions-spacer"));

      expect(actionsIndex).toBeGreaterThanOrEqual(0);
      expect(spacerIndex).toBeGreaterThan(actionsIndex);
      expect(standardFooter?.querySelector(".detail-move-dropdown, .detail-move-btn, .detail-move-menu")).toBeNull();
    });

    it("keeps the triage footer recoverable through Actions", () => {
      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "triage" as Column })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onRetryTask={async () => makeTask()}
          onResetTask={async () => makeTask()}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      const footer = container.querySelector(".modal-actions");

      expect(footer?.querySelector(".detail-actions-dropdown")).toBeTruthy();
      expect(footer?.querySelector(".modal-actions-spacer")).toBeTruthy();
      expect(footer?.querySelector(".detail-move-dropdown, .detail-move-btn, .detail-move-menu")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      expect(screen.getByRole("menuitem", { name: "Retry" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Reset" })).toBeTruthy();
      expect(screen.getAllByRole("menuitem", { name: "Delete" })).toHaveLength(1);
    });

    it("modal-actions contains Delete and Pause buttons for non-done tasks (via Actions dropdown)", () => {
      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-progress" as Column })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Actions are now in a dropdown - open it first.
      // FNXC:PlannerOversight 2026-07-05-00:00: FN-7604 — the footer "Actions"
      // dropdown button name must be matched EXACTLY (not `/actions/i`) because
      // the now-universal Oversight overflow trigger's aria-label is "Oversight
      // actions", which also matches a loose /actions/i regex and made this
      // query ambiguous once the trigger stopped being mobile-only.
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
      fireEvent.click(actionsBtn);

      // Now the dropdown items should be visible
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Pause" })).toBeTruthy();
    });

    it("passes githubIssueAction for tracked tasks", async () => {
      const onDeleteTask = vi.fn().mockResolvedValue({} as Task);

      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            githubTracking: {
              enabled: true,
              issue: {
                owner: "owner",
                repo: "repo",
                number: 42,
                url: "https://github.com/owner/repo/issues/42",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
          })}
          onClose={noop}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { githubIssueAction: "close", allowResurrection: false });
      });
    });

    it("passes githubIssueAction=delete for tracked tasks", async () => {
      const onDeleteTask = vi.fn().mockResolvedValue({} as Task);
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00.000Z" } } })}
          onClose={noop}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { githubIssueAction: "delete", allowResurrection: false });
      });
    });

    it("passes githubIssueAction=leave for tracked tasks", async () => {
      const onDeleteTask = vi.fn().mockResolvedValue({} as Task);
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00.000Z" } } })}
          onClose={noop}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { githubIssueAction: "leave", allowResurrection: false });
      });
    });

    it("keeps legacy delete payload for untracked tasks", async () => {
      const onDeleteTask = vi.fn().mockResolvedValue({} as Task);
      mockConfirm.mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask()}
          onClose={noop}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { allowResurrection: false });
      });
    });

    it("prompts for dependency-removal confirmation and retries delete with explicit flag", async () => {
      const onDeleteTask = vi.fn();
      const conflict = new Error("Cannot delete task FN-099: still referenced as a dependency by FN-100, FN-101.") as Error & {
        status: number;
        details: { code: string; dependentIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-100", "FN-101"] };
      onDeleteTask
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({} as Task);

      mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: false });
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00.000Z" } } })}
          onClose={noop}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenNthCalledWith(1, {
          title: "Linked GitHub Issue",
          message: "Choose what to do with owner/repo#42 when deleting FN-099.\n\nClose the issue?",
          confirmLabel: "Close Issue",
          cancelLabel: "More Options",
        });
        expect(mockConfirm).toHaveBeenNthCalledWith(2, {
          title: "Delete Linked GitHub Issue",
          message: "Delete owner/repo#42 on GitHub, or leave it unchanged?",
          confirmLabel: "Delete Issue",
          cancelLabel: "Leave Unchanged",
          danger: true,
        });
        expect(mockConfirm).toHaveBeenNthCalledWith(3, {
          title: "Force Delete Task",
          message: "FN-099 is a dependency of FN-100, FN-101.\n\nDelete anyway by removing these dependency references first?",
          danger: true,
        });
      });

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenNthCalledWith(1, "FN-099", { githubIssueAction: "delete", allowResurrection: false });
        expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-099", {
          removeDependencyReferences: true,
          removeLineageReferences: true,
          githubIssueAction: "delete",
          allowResurrection: false,
        });
        expect(noop).toHaveBeenCalledWith("Deleted FN-099 after removing dependency references", "info");
      });
    });

    it("does not retry delete when dependency-removal confirmation is canceled", async () => {
      const onDeleteTask = vi.fn();
      const conflict = new Error("Cannot delete task FN-099: still referenced as a dependency by FN-102.") as Error & {
        status: number;
        details: { code: string; dependentIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-102"] };
      onDeleteTask.mockRejectedValue(conflict);

      mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: false });
      mockConfirm.mockResolvedValueOnce(false);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask()}
          onClose={noop}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledTimes(1);
        expect(onDeleteTask).toHaveBeenCalledTimes(1);
      });
    });

    it("does not retry delete when lineage-force confirmation is canceled", async () => {
      const onDeleteTask = vi.fn();
      const conflict = new Error("Cannot delete task FN-099: still referenced as a lineage parent by FN-104.") as Error & {
        status: number;
        details: { code: string; lineageChildIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-104"] };
      onDeleteTask.mockRejectedValue(conflict);

      mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: false });
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00.000Z" } } })}
          onClose={noop}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledTimes(2);
        expect(onDeleteTask).toHaveBeenCalledTimes(1);
      });
    });

    it("shows error when dependency-removal retry fails", async () => {
      const onDeleteTask = vi.fn();
      const conflict = new Error("Cannot delete task FN-099: still referenced as a dependency by FN-103.") as Error & {
        status: number;
        details: { code: string; dependentIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-103"] };
      onDeleteTask
        .mockRejectedValueOnce(conflict)
        .mockRejectedValueOnce(new Error("Retry failed"));

      mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: false });
      mockConfirm.mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask()}
          onClose={noop}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-099", {
          removeDependencyReferences: true,
          removeLineageReferences: true,
          allowResurrection: false,
        });
        expect(noop).toHaveBeenCalledWith("Retry failed", "error");
      });
    });

    it("retries delete after lineage-conflict confirmation", async () => {
      const onDeleteTask = vi.fn();
      const conflict = new Error("Cannot delete task FN-099: still referenced as a lineage parent by FN-103.") as Error & {
        status: number;
        details: { code: string; lineageChildIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-103"] };
      onDeleteTask
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({} as Task);

      mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "primary", checkboxValue: false });
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo", number: 42, url: "https://github.com/owner/repo/issues/42", createdAt: "2026-01-01T00:00:00.000Z" } } })}
          onClose={noop}
          onDeleteTask={onDeleteTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-099", {
          removeDependencyReferences: true,
          removeLineageReferences: true,
          githubIssueAction: "close",
          allowResurrection: false,
        });
      });
    });




    it("keeps the in-review Merge & Close action in the footer without relocation controls", () => {
      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-review" as Column })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByRole("button", { name: "Merge & Close" })).toBeTruthy();
      expect(document.querySelector(".detail-move-dropdown, .detail-move-btn, .detail-move-menu")).toBeNull();
    });

    it("keeps Merge & Close when pull-request strategy has autoMerge enabled", async () => {
      const { fetchSettings } = await import("../../api");
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        mergeStrategy: "pull-request",
        autoMerge: true,
      });

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-review" as Column })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(await screen.findByRole("button", { name: "Merge & Close" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Start PR Review" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Check PR Status" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Finish & Close" })).toBeNull();
    });

    it("shows Start PR Review and opens PR creation for pull-request strategy when autoMerge is off and no PR exists", async () => {
      const { fetchSettings } = await import("../../api");
      const onMergeTask = vi.fn(async () => ({ merged: false } as MergeResult));
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        mergeStrategy: "pull-request",
        autoMerge: false,
      });

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-review" as Column })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={onMergeTask}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const button = await screen.findByRole("button", { name: "Start PR Review" });
      fireEvent.click(button);

      expect(await screen.findByRole("heading", { name: "Create Pull Request" })).toBeInTheDocument();
      expect(onMergeTask).not.toHaveBeenCalled();
    });

    it("refreshes PR status for Check PR Status without merge prompt", async () => {
      const { fetchSettings, refreshPrStatus } = await import("../../api");
      const addToast = vi.fn();
      const onMergeTask = vi.fn(async () => ({ merged: false } as MergeResult));
      const onTaskUpdated = vi.fn();

      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        mergeStrategy: "pull-request",
        autoMerge: false,
      });
      vi.mocked(refreshPrStatus).mockResolvedValueOnce({
        prInfo: {
          url: "https://github.com/owner/repo/pull/42",
          number: 42,
          status: "open",
          title: "Task",
          headBranch: "fusion/fn-099",
          baseBranch: "main",
          commentCount: 1,
        },
        all: [],
      });

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            column: "in-review" as Column,
            prInfo: {
              url: "https://github.com/owner/repo/pull/42",
              number: 42,
              status: "open",
              title: "Task",
              headBranch: "fusion/fn-099",
              baseBranch: "main",
              commentCount: 0,
            },
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={onMergeTask}
          onOpenDetail={noopOpenDetail}
          onTaskUpdated={onTaskUpdated}
          addToast={addToast}
          projectId="project-1"
        />,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Check PR Status" }));

      await waitFor(() => {
        expect(refreshPrStatus).toHaveBeenCalledWith("FN-099", "project-1");
      });
      expect(onMergeTask).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(addToast).toHaveBeenCalledWith("PR status refreshed", "success");
    });

    it("shows error toast when Check PR Status refresh fails", async () => {
      const { fetchSettings, refreshPrStatus } = await import("../../api");
      const addToast = vi.fn();
      const onMergeTask = vi.fn(async () => ({ merged: false } as MergeResult));

      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        mergeStrategy: "pull-request",
        autoMerge: false,
      });
      vi.mocked(refreshPrStatus).mockRejectedValueOnce(new Error("refresh failed"));

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            column: "in-review" as Column,
            prInfo: {
              url: "https://github.com/owner/repo/pull/42",
              number: 42,
              status: "open",
              title: "Task",
              headBranch: "fusion/fn-099",
              baseBranch: "main",
              commentCount: 0,
            },
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={onMergeTask}
          onOpenDetail={noopOpenDetail}
          addToast={addToast}
        />,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Check PR Status" }));

      await waitFor(() => {
        expect(refreshPrStatus).toHaveBeenCalledWith("FN-099", undefined);
      });
      expect(onMergeTask).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(addToast).toHaveBeenCalledWith("refresh failed", "error");
    });

    it.each([
      [{ status: "open" as const }, "Check PR Status"],
      [{ status: "merged" as const }, "Finish & Close"],
    ])("shows %s footer label in manual PR flow", async (prInfoStatus, expectedLabel) => {
      const { fetchSettings } = await import("../../api");
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        mergeStrategy: "pull-request",
        autoMerge: false,
      });

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({
            column: "in-review" as Column,
            prInfo: {
              url: "https://github.com/owner/repo/pull/42",
              number: 42,
              status: prInfoStatus.status,
              title: "Task",
              headBranch: "fusion/fn-099",
              baseBranch: "main",
              commentCount: 0,
            },
          })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(await screen.findByRole("button", { name: expectedLabel })).toBeTruthy();
      expect(screen.queryByText("Merge & Close")).toBeNull();
    });

    it("shows linked PR number in detail metadata for in-review tasks", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ column: "in-review" as Column, prInfo: {
            url: "https://github.com/owner/repo/pull/42",
            number: 42,
            status: "open",
            title: "Task",
            headBranch: "fusion/fn-099",
            baseBranch: "main",
            commentCount: 0,
          } })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByRole("link", { name: "#42" })).toHaveAttribute("href", "https://github.com/owner/repo/pull/42");
    });

    it("shows linked PR number in Summary merge details, not Definition, for done tasks", () => {
      const task = makeTask({
        column: "done" as Column,
        prInfo: {
          url: "https://github.com/owner/repo/pull/42",
          number: 42,
          status: "merged",
          title: "Task",
          headBranch: "fusion/fn-099",
          baseBranch: "main",
          commentCount: 0,
        },
        mergeDetails: { prNumber: 42 },
      });
      const summary = render(
        <TaskDetailModal
          initialTab="summary"
          task={task}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(summary.baseElement.querySelector(".detail-section--summary .merge-details-card a")).toHaveAttribute("href", "https://github.com/owner/repo/pull/42");
      summary.unmount();

      render(
        <TaskDetailModal
          initialTab="definition"
          task={task}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText("Merge Details")).toBeNull();
    });

    it("shows PR automation waiting label instead of Merge & Close when awaiting PR checks", () => {
      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-review" as Column, status: "awaiting-pr-checks", prInfo: {
            url: "https://github.com/owner/repo/pull/42",
            number: 42,
            status: "open",
            title: "Task",
            headBranch: "fusion/fn-099",
            baseBranch: "main",
            commentCount: 0,
          } })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const button = screen.getByText("Awaiting PR checks").closest("button") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(screen.queryByText("Merge & Close")).toBeNull();
    });

    it("shows Creating PR label while PR-first automation is creating a PR", () => {
      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-review" as Column, status: "creating-pr" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const button = screen.getByText("Creating PR…").closest("button") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(screen.queryByText("Merge & Close")).toBeNull();
    });
  });

  describe("dependency dropdown search", () => {
    const searchTasks: Task[] = [
      { id: "FN-010", title: "Fix login bug", description: "Users cannot log in", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "FN-020", title: "Add dark mode", description: "Theme support", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
      { id: "FN-030", title: "Refactor API", description: "Clean up endpoints", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" },
      { id: "FN-099", description: "Self", column: "in-progress" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-03-15T00:00:00Z", updatedAt: "2026-03-15T00:00:00Z" },
    ];

    function renderWithSearch(taskOverrides: Partial<TaskDetail> = {}) {
      return render(
        <TaskDetailModal
          initialTab="dependencies"
          task={makeTask(taskOverrides)}
          tasks={searchTasks}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
    }

    it("shows search input when dropdown is opened", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.placeholder).toBe("Search tasks…");
    });

    it("filters tasks by search term", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "login" } });

      const items = document.querySelectorAll(".dep-dropdown-item");
      expect(items).toHaveLength(1);
      expect(items[0].querySelector(".dep-dropdown-id")?.textContent).toBe("FN-010");
    });

    it("matches task ID case-insensitively", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "fn-020" } });

      const items = document.querySelectorAll(".dep-dropdown-item");
      expect(items).toHaveLength(1);
      expect(items[0].querySelector(".dep-dropdown-id")?.textContent).toBe("FN-020");
    });

    it("matches task title", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "dark mode" } });

      const items = document.querySelectorAll(".dep-dropdown-item");
      expect(items).toHaveLength(1);
      expect(items[0].querySelector(".dep-dropdown-id")?.textContent).toBe("FN-020");
    });

    it("shows empty state when search matches nothing", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "zzz-nonexistent" } });

      const items = document.querySelectorAll(".dep-dropdown-item");
      expect(items).toHaveLength(0);
      expect(document.querySelector(".dep-dropdown-empty")?.textContent).toBe("No available tasks");
    });

    it("resets search when dropdown closes and reopens", () => {
      renderWithSearch();
      fireEvent.click(screen.getByText("Add Dependency"));
      const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "login" } });
      expect(input.value).toBe("login");

      // Close by clicking again
      fireEvent.click(screen.getByText("Add Dependency"));
      expect(document.querySelector(".dep-dropdown")).toBeNull();

      // Reopen
      fireEvent.click(screen.getByText("Add Dependency"));
      const newInput = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
      expect(newInput.value).toBe("");
      // All items visible again
      expect(document.querySelectorAll(".dep-dropdown-item")).toHaveLength(3);
    });
  });

  /*
  FNXC:DashboardTests 2026-08-09-08:06:
  FN-8887 keeps the hydration contract explicit: full TaskDetail props contain `prompt`, so
  TaskDetailContent returns before a mount fetch. Only slim Task props hydrate on mount.
  Dependencies and Blocking share this component across desktop and mobile hosts; both
  `.detail-dep-link` sites exercise the same scoped navigation path.
  */
  describe("clickable dependency links", () => {
    it("renders dependency list items with clickable class and ID + label", () => {
      // Provide tasks prop to enable title lookup
      const allTasks: Task[] = [
        { id: "FN-001", title: "Fix login bug", description: "Login broken", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
        { id: "FN-002", title: "Add tests", description: "Test coverage", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ];

      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="dependencies"
          task={makeTask({ dependencies: ["FN-001", "FN-002"] })}
          tasks={allTasks}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const depLinks = container.querySelectorAll(".detail-dep-link");
      expect(depLinks).toHaveLength(2);

      // Check detail-dep-id elements
      const depIds = container.querySelectorAll(".detail-dep-id");
      expect(depIds).toHaveLength(2);
      expect(depIds[0].textContent).toBe("FN-001");
      expect(depIds[1].textContent).toBe("FN-002");

      // Check detail-dep-label elements
      const depLabels = container.querySelectorAll(".detail-dep-label");
      expect(depLabels).toHaveLength(2);
      expect(depLabels[0].textContent).toBe("Fix login bug");
      expect(depLabels[1].textContent).toBe("Add tests");
    });

    it("renders dependency label from description when title is not available", () => {
      const allTasks: Task[] = [
        { id: "FN-001", description: "Login is broken", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ];

      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="dependencies"
          task={makeTask({ dependencies: ["FN-001"] })}
          tasks={allTasks}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const depLabels = container.querySelectorAll(".detail-dep-label");
      expect(depLabels).toHaveLength(1);
      expect(depLabels[0].textContent).toBe("Login is broken");
    });

    it("renders dependency ID as label when no title or description available", () => {
      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="dependencies"
          task={makeTask({ dependencies: ["FN-001"] })}
          // No tasks prop - dependency not found
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const depLabels = container.querySelectorAll(".detail-dep-label");
      expect(depLabels).toHaveLength(1);
      // Should fall back to the ID itself
      expect(depLabels[0].textContent).toBe("FN-001");
    });

    it("truncates long dependency labels at 40 characters", () => {
      // Title is exactly 50 chars, should be truncated to 40 with ellipsis
      const longTitle = "This is a very long task title that exceeds the limit";
      const allTasks: Task[] = [
        { id: "FN-001", title: longTitle, description: "Short desc", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ];

      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="dependencies"
          task={makeTask({ dependencies: ["FN-001"] })}
          tasks={allTasks}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const depLabels = container.querySelectorAll(".detail-dep-label");
      expect(depLabels).toHaveLength(1);
      // Title is 50 chars, should be truncated to 40 with ellipsis
      // "This is a very long task title that exceed" + "…" = 41 chars
      expect(depLabels[0].textContent!.length).toBe(41); // 40 chars + ellipsis
      expect(depLabels[0].textContent).toContain("…");
    });

    it("preserves full text in title attribute for truncated labels", () => {
      const allTasks: Task[] = [
        { id: "FN-001", title: "Very long title that gets truncated in the UI but should show full text on hover", description: "Desc", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ];

      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="dependencies"
          task={makeTask({ dependencies: ["FN-001"] })}
          tasks={allTasks}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const depLink = container.querySelector(".detail-dep-link")!;
      // The title attribute should contain the full ID for context
      expect(depLink.getAttribute("title")).toContain("FN-001");
    });

    it("calls fetchTaskDetail with project scope and opens the exact fetched dependency", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      const projectId = "project-dependencies";
      const task = makeTask({ dependencies: ["FN-001"] });
      const mockDetail = makeTask({ id: "FN-001", description: "Dep 1" });
      const onOpenDetail = vi.fn();

      /*
      FNXC:TaskDetailDependencies 2026-08-08-12:32:
      A TaskDetail prop refreshes Definition through fetchTaskPrompt. The full-detail client is
      reserved for the clicked dependency, so fail this fixture on any other request.
      */
      mockFetch.mockReset();
      mockFetch.mockImplementation(async (id: string, requestedProjectId?: string) => {
        if (id !== "FN-001" || requestedProjectId !== projectId) {
          throw new Error(`Unexpected dependency detail request: ${id}`);
        }
        return mockDetail;
      });
      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="dependencies"
          projectId={projectId}
          task={task}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );
      await waitFor(() => expect(mockFetch).not.toHaveBeenCalled());

      fireEvent.click(container.querySelector(".detail-dep-link")!);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith("FN-001", projectId);
        expect(onOpenDetail).toHaveBeenCalledExactlyOnceWith(mockDetail);
      });
    });

    it("fetches an unscoped dependency with an undefined project ID", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      const task = makeTask({ dependencies: ["FN-001"] });
      const mockDetail = makeTask({ id: "FN-001", description: "Unscoped dependency" });
      const onOpenDetail = vi.fn();

      mockFetch.mockResolvedValue(mockDetail);
      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="dependencies"
          task={task}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );
      await waitFor(() => expect(mockFetch).not.toHaveBeenCalled());

      fireEvent.click(container.querySelector(".detail-dep-link")!);
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledExactlyOnceWith("FN-001", undefined);
        expect(onOpenDetail).toHaveBeenCalledExactlyOnceWith(mockDetail);
      });
    });

    it("hydrates a slim task once before fetching its dependency", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      const projectId = "project-dependencies";
      const fullTask = makeTask({ dependencies: ["FN-001"] });
      const { prompt: _prompt, ...slimTask } = fullTask;

      mockFetch.mockResolvedValue(fullTask);
      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="dependencies"
          projectId={projectId}
          task={slimTask}
          onOpenDetail={noopOpenDetail}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      await waitFor(() => expect(mockFetch).toHaveBeenCalledExactlyOnceWith("FN-099", projectId));
      fireEvent.click(container.querySelector(".detail-dep-link")!);
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenNthCalledWith(2, "FN-001", projectId);
      });
    });

    it("shows exactly one error toast and never navigates when dependency fetch fails", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      const projectId = "project-dependencies";
      const task = makeTask({ dependencies: ["FN-001"] });
      const onOpenDetail = vi.fn();
      const addToast = vi.fn();

      /*
      FNXC:TaskDetailDependencies 2026-08-08-12:32:
      Definition refresh uses fetchTaskPrompt. Reject the expected dependency request and fail this
      fixture distinctly if another full-detail request appears.
      */
      mockFetch.mockReset();
      mockFetch.mockImplementation(async (id: string, requestedProjectId?: string) => {
        if (id !== "FN-001" || requestedProjectId !== projectId) {
          throw new Error(`Unexpected dependency detail request: ${id}`);
        }
        throw new Error("Task not found");
      });
      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="dependencies"
          projectId={projectId}
          task={task}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={addToast}
        />,
      );
      await waitFor(() => expect(mockFetch).not.toHaveBeenCalled());

      fireEvent.click(container.querySelector(".detail-dep-link")!);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledExactlyOnceWith("FN-001", projectId);
        expect(addToast).toHaveBeenCalledExactlyOnceWith("Failed to load dependency FN-001", "error");
      });
      expect(onOpenDetail).not.toHaveBeenCalled();
    });

    it("activates upstream and blocking-dependent links with Enter and Space", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      const projectId = "project-dependencies";
      const task = makeTask({ dependencies: ["FN-001"] });
      const upstreamDetail = makeTask({ id: "FN-001", description: "Upstream dependency" });
      const blockingDetail = makeTask({ id: "FN-100", description: "Blocking dependent" });
      const onOpenDetail = vi.fn();

      mockFetch.mockReset();
      mockFetch.mockImplementation(async (id: string, requestedProjectId?: string) => {
        if (requestedProjectId !== projectId) {
          throw new Error(`Unexpected dependency project: ${requestedProjectId ?? "<none>"}`);
        }
        if (id === "FN-001") return upstreamDetail;
        if (id === "FN-100") return blockingDetail;
        throw new Error(`Unexpected dependency detail request: ${id}`);
      });
      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="dependencies"
          projectId={projectId}
          task={task}
          tasks={[task, makeTask({ id: "FN-100", dependencies: [task.id] })]}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );
      await waitFor(() => expect(mockFetch).not.toHaveBeenCalled());

      const [upstreamLink, blockingLink] = Array.from(container.querySelectorAll<HTMLElement>(".detail-dep-link"));
      fireEvent.keyDown(upstreamLink, { key: "Enter" });
      fireEvent.keyDown(blockingLink, { key: " " });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenNthCalledWith(1, "FN-001", projectId);
        expect(mockFetch).toHaveBeenNthCalledWith(2, "FN-100", projectId);
        expect(onOpenDetail).toHaveBeenNthCalledWith(1, upstreamDetail);
        expect(onOpenDetail).toHaveBeenNthCalledWith(2, blockingDetail);
      });
    });

    it("remove button click does not fetch or open a dependency", async () => {
      const { updateTask, fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      const task = makeTask({ dependencies: ["FN-001"] });
      const onOpenDetail = vi.fn();

      render(
        <TaskDetailModal
          initialTab="dependencies"
          task={task}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );
      await waitFor(() => expect(mockFetch).not.toHaveBeenCalled());

      fireEvent.click(screen.getByTitle(/Remove dependency/));

      await waitFor(() => {
        expect(updateTask).toHaveBeenCalledWith("FN-099", { dependencies: [] }, undefined);
      });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(onOpenDetail).not.toHaveBeenCalled();
    });
  });

  describe("blocking section", () => {
    it("renders downstream dependents and stale annotations", () => {
      const tasks = [
        makeTask({ id: "FN-099", title: "Blocker", column: "done" as Column }),
        makeTask({ id: "FN-100", title: "Todo dependent", column: "todo" as Column, dependencies: ["FN-099"] }),
        makeTask({ id: "FN-101", title: "Stale blockedBy dependent", column: "todo" as Column, blockedBy: "FN-099" }),
      ];

      const { baseElement: container } = render(
        <TaskDetailModal
          initialTab="dependencies"
          task={tasks[0]}
          tasks={tasks}
          onOpenDetail={noopOpenDetail}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Blocking")).toBeTruthy();
      expect(container.textContent).toContain("FN-100");
      expect(container.textContent).toContain("FN-101");
      expect(container.querySelector(".detail-blocking-item--stale")?.textContent).toBe("(stale)");
    });
  });



});
