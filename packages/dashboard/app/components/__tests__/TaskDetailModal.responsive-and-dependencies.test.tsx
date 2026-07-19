/*
FNXC:TaskDetailTabs 2026-06-17-08:20:
FN-7306 labels the stable internal `chat` tab as Activity and keeps it as the default TaskDetailModal tab. Tests that assert Definition-only sections must opt into `initialTab="definition"` so they verify the intended surface instead of the Activity landing state.
*/
import { describe, it, expect, vi } from "vitest";
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
      expect(composerBlock).toContain("display: flex;");
      expect(composerBlock).toContain("flex-wrap: wrap;");
      expect(composerBlock).toContain("align-items: stretch;");
      expect(composerBlock).toContain("flex: 0 0 auto;");
      expect(composerBlock).not.toContain("flex-direction: column;");
      expect(inputBlock).toContain("height: calc(var(--space-2xl) + var(--space-sm));");
      expect(inputBlock).toContain("min-height: calc(var(--space-2xl) + var(--space-sm));");
      expect(inputBlock).not.toContain("min-height: 5rem;");
      expect(mobileComposerBlock).toContain("flex-direction: row;");
      expect(mobileComposerBlock).toContain("flex-wrap: nowrap;");
      expect(mobileComposerBlock).toContain("align-items: flex-end;");
      expect(mobileInputBlock).toContain("height: calc(var(--space-2xl) + var(--space-lg));");
      expect(mobileInputBlock).toContain("min-height: calc(var(--space-2xl) + var(--space-lg));");
      expect(mobileInputBlock).toContain("max-height: calc(var(--space-2xl) + var(--space-lg));");
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
      const plannerExpandedMetaBlock = getExactCssRuleBlock(detailCss, ".task-detail-content--planner-chat-expanded .detail-meta");
      expectBaseRule(detailCss, ".detail-body--planner-chat", "overflow-y: hidden;");
      expectBaseRule(detailCss, ".detail-section--planner-chat", "min-height: 0;");
      expect(detailCss).toContain(".task-detail-content--planner-chat-expanded .detail-provenance");
      expect(detailCss).toContain(".task-detail-content--planner-chat-expanded .modal-actions");
      expect(detailCss).toContain(".task-detail-content--planner-chat-expanded .detail-tabs");
      expect(detailCss).toContain(".task-detail-content--planner-chat-expanded .detail-meta-inline-controls");
      expect(detailCss).not.toContain(".task-detail-content--planner-chat-expanded .detail-heading-row");
      expect(detailCss).not.toMatch(/\.task-detail-content--planner-chat-expanded \.detail-timestamps\s*\{/);
      expect(detailCss).toContain(".task-detail-content--planner-chat-expanded .detail-timestamps .detail-timestamp-item");
      expect(detailCss).not.toMatch(/\.task-detail-content--planner-chat-expanded \.detail-meta,\s*\.task-detail-content--planner-chat-expanded \.detail-near-duplicate-banner/);
      expect(detailCss).not.toMatch(/\.task-detail-content--planner-chat-expanded \.detail-tabs,\s*\.task-detail-content--planner-chat-expanded \.branch-group-card/);
      expect(plannerExpandedMetaBlock).toContain("flex: 0 0 auto;");
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
      const mobilePlannerBlock = getCssAtRuleBlockContaining(css, "@media (max-width: 768px)", ".detail-body--chat");
      const mobilePlannerBodyBlock = getStandaloneCssRuleBlock(mobilePlannerBlock, ".detail-body--planner-chat");
      const mobileExpandedPlannerBodyBlock = getExactCssRuleBlock(mobilePlannerBlock, ".task-detail-content--planner-chat-expanded .detail-body--planner-chat");

      expect(detailBodyBlock).toContain("padding: calc(var(--space-lg) + var(--space-xs));");
      expect(mobileDetailBodyBlock).toContain("padding: calc(var(--space-md) + var(--space-xs) / 2);");
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

    it("keeps detail metadata as a single wrapping flex row without mobile column fallbacks", () => {
      const css = readDashboardStylesSource();

      expectBaseRule(css, ".detail-meta", "display: flex;");
      expectBaseRule(css, ".detail-meta", "flex-wrap: wrap;");
      expect(css).not.toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.detail-meta\s*\{[^}]*flex-direction:\s*column;/);
      expect(css).not.toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.detail-meta-inline-controls\s*\{[^}]*flex-direction:\s*column;/);
      expect(css).not.toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.detail-timestamps\s*\{[^}]*flex-direction:\s*column;/);
    });

    it("keeps inline metadata controls in a single row with a wrapping mobile fallback", () => {
      const css = readDashboardStylesSource();
      const mobileBlock = getCssAtRuleBlockContaining(css, "@media (max-width: 768px)", ".detail-meta-inline-controls");

      expectBaseRule(css, ".detail-meta-inline-controls", "display: flex;");
      expectBaseRule(css, ".detail-meta-inline-controls", "flex-wrap: nowrap;");
      expect(mobileBlock).toMatch(/\.detail-meta-inline-controls\s*\{[^}]*flex-wrap:\s*wrap;/);
      expect(mobileBlock).not.toMatch(/\.detail-meta-inline-controls\s*\{[^}]*flex-direction:\s*column;/);
      expect(css).not.toMatch(/@media \(max-width: 640px\)\s*\{[^}]*\.detail-meta-inline-controls\s*\{[^}]*flex-direction:\s*column;/);
    });

    it("scopes tokenized SVG sizing to every inline-row descendant without changing breakpoint scaffolding", () => {
      const css = readDashboardStylesSource();
      const tabletBlock = getCssAtRuleBlockContaining(css, "@media (min-width: 769px) and (max-width: 1024px)", ".modal.task-detail-modal");
      const mobileBlock = getCssAtRuleBlockContaining(css, "@media (max-width: 768px)", ".detail-meta-inline-controls");
      const rowSvgBlock = getExactCssRuleBlock(css, ".detail-meta-inline-controls svg");

      // FNXC:TaskDetailModalResponsive 2026-07-19-12:00: Source guards preserve
      // the scoped token contract; Blink smoke separately proves computed sizes.
      expect(rowSvgBlock).toContain("width: var(--icon-size-sm);");
      expect(rowSvgBlock).toContain("height: var(--icon-size-sm);");
      expect(rowSvgBlock).toContain("flex-shrink: 0;");
      expect(css).not.toMatch(/\.detail-meta-inline-controls svg\s*\{[^}]*width:\s*1em/);
      expect(tabletBlock).not.toBe("");
      expect(mobileBlock).toMatch(/\.detail-meta-inline-controls\s*\{[^}]*flex-wrap:\s*wrap;/);
    });

    it("gives every task-detail inline action the shared square tokenized box across themes (FN-8287)", () => {
      const css = readDashboardStylesSource();
      const sharedSizingSelector = [
        ".detail-inline-attach",
        ".detail-inline-github-toggle",
        ".detail-priority-trigger",
        ".detail-oversight-menu-trigger",
        ".detail-execution-mode-toggle",
      ].join(",\n");
      const sharedSizingBlock = getCssRuleBlock(css, sharedSizingSelector);

      // FNXC:TaskDetail 2026-07-17-17:30: Attach, GitHub, Priority,
      // Oversight, and Fast must read one common rule so theme-specific
      // spacing/icon tokens cannot desynchronize their square footprints.
      expect(sharedSizingBlock).toContain("height: var(--detail-priority-control-min-height);");
      expect(sharedSizingBlock).toContain("min-height: var(--detail-priority-control-min-height);");
      expect(sharedSizingBlock).toContain("width: var(--detail-priority-control-min-height);");
      expect(sharedSizingBlock).toContain("min-width: var(--detail-priority-control-min-height);");
      expect(sharedSizingBlock).toContain("box-sizing: border-box;");
      expect(sharedSizingBlock).toContain("border-width: var(--btn-border-width);");
      expect(sharedSizingBlock).toContain("border-color: var(--border);");
      expect(sharedSizingBlock).toContain("border-radius: var(--detail-control-border-radius);");
    });

    it.skip("unifies border/radius/height across the Priority, Execution-mode, and Oversight quick controls (FN-7585)", () => {
      const css = readDashboardStylesSource();

      const inlineControlsBlock = getStandaloneCssRuleBlock(css, ".detail-meta-inline-controls");
      const priorityChipBlock = getExactCssRuleBlock(css, ".detail-priority-chip");
      const executionToggleBlock = getExactCssRuleBlock(css, ".detail-execution-mode-toggle");
      const oversightTriggerBlock = getExactCssRuleBlock(css, ".detail-oversight-menu-trigger");

      // The cluster declares one shared border-radius token; all three
      // controls must reference it rather than independent literal radii.
      // FNXC:PlannerOversight 2026-07-05-00:00: FN-7604 removed the desktop-only
      // `.detail-oversight-chip` wrapper (the inline branch it styled was
      // deleted); the Oversight surface is now represented solely by
      // `.detail-oversight-menu-trigger`, which already carried this trio.
      expect(inlineControlsBlock).toContain("--detail-control-border-radius: var(--radius-md);");
      for (const block of [priorityChipBlock, executionToggleBlock, oversightTriggerBlock]) {
        expect(block).toContain("border-radius: var(--detail-control-border-radius);");
        expect(block).toContain("border-width: var(--btn-border-width);");
        expect(block).toContain("border-color: var(--border);");
        // Same height token as the rest of the invariant.
        expect(block).toContain("min-height: var(--detail-priority-control-min-height);");
        expect(block).toContain("box-sizing: border-box;");
      }

      // Guard against regressing back to independent literal radius values
      // (e.g. reintroducing a bare `var(--radius-pill)` on the priority chip).
      expect(priorityChipBlock).not.toMatch(/border-radius:\s*var\(--radius-pill\)/);
      expect(oversightTriggerBlock).not.toMatch(/border-radius:\s*var\(--radius-pill\)/);
    });

    it.skip("stretches the Oversight dropdown wrapper so the trigger matches the Priority/Execution-mode row height on every surface (FN-7618)", () => {
      const css = readDashboardStylesSource();
      const mobileBlock = getCssAtRuleBlockContaining(css, "@media (max-width: 768px)", ".detail-meta-inline-controls");

      const priorityChipBlock = getExactCssRuleBlock(css, ".detail-priority-chip");
      const executionToggleBlock = getExactCssRuleBlock(css, ".detail-execution-mode-toggle");
      const oversightTriggerBlock = getExactCssRuleBlock(css, ".detail-oversight-menu-trigger");
      const oversightDropdownBlock = getExactCssRuleBlock(css, ".detail-oversight-menu-dropdown");
      const oversightMenuBlock = getExactCssRuleBlock(css, ".detail-oversight-menu");

      // Priority and Execution-mode are direct flex children of
      // `.detail-meta-inline-controls { align-items: stretch }`, so they
      // stretch to the shared row height via the same min-height token.
      for (const block of [priorityChipBlock, executionToggleBlock, oversightTriggerBlock]) {
        expect(block).toContain("min-height: var(--detail-priority-control-min-height);");
      }

      // The Oversight trigger instead lives inside a `position: relative`
      // `.detail-oversight-menu-dropdown` wrapper (required for the popover's
      // absolute positioning). Without the wrapper itself participating in
      // the cluster's stretch, the trigger only gets its own intrinsic
      // min-height and renders shorter than its siblings on non-mobile
      // widths. Assert the wrapper stretches and the trigger fills it, so a
      // future change that drops either declaration fails this test.
      expect(oversightDropdownBlock).toContain("position: relative;");
      expect(oversightDropdownBlock).toContain("display: inline-flex;");
      expect(oversightDropdownBlock).toContain("align-items: stretch;");
      expect(oversightTriggerBlock).toContain("align-self: stretch;");

      // This invariant is not scoped to a mobile-only media block: the
      // cluster's base rule (which the dropdown/trigger rules above read
      // from) applies at every width, and there must be no non-mobile
      // override that removes the stretch behavior.
      expect(css).not.toMatch(/@media[^{]*\(min-width:[^{]*\{[\s\S]*?\.detail-oversight-menu-dropdown\s*\{[^}]*align-items:\s*(?:center|flex-start|flex-end);/);

      // The wrapper stretch must not affect the popover: it stays absolutely
      // positioned (independent of the flex layout) and unstretched.
      expect(oversightMenuBlock).toContain("position: absolute;");
      expect(oversightMenuBlock).not.toContain("align-self: stretch;");
      expect(oversightMenuBlock).not.toMatch(/height:\s*100%/);

      // No `@media (max-width: 768px)` override removes the wrapper's stretch
      // declarations, so the mobile `flex-wrap: wrap` fallback keeps the same
      // fix in effect.
      expect(mobileBlock).not.toMatch(/\.detail-oversight-menu-dropdown\s*\{[^}]*align-items:\s*(?:center|flex-start|flex-end|normal);/);
      expect(mobileBlock).not.toMatch(/\.detail-oversight-menu-trigger\s*\{[^}]*align-self:\s*(?:auto|center|flex-start|flex-end);/);
    });

    it.skip("resolves the same fixed box height for Priority, Execution-mode, and the Oversight trigger, not just a shared floor (FN-7633)", () => {
      const css = readDashboardStylesSource();
      const mobileBlock = getCssAtRuleBlockContaining(css, "@media (max-width: 768px)", ".detail-meta-inline-controls");

      const priorityChipBlock = getExactCssRuleBlock(css, ".detail-priority-chip");
      const executionToggleBlock = getExactCssRuleBlock(css, ".detail-execution-mode-toggle");
      const oversightTriggerBlock = getExactCssRuleBlock(css, ".detail-oversight-menu-trigger");
      const oversightMenuBlock = getExactCssRuleBlock(css, ".detail-oversight-menu");

      // FN-7618 gave the Oversight trigger `align-self: stretch` so it fills
      // its wrapper's stretched row height, while Priority and Execution-mode
      // were only floored via `min-height` — a floor is not a guarantee of
      // equality, so on desktop the trigger could resolve taller than its
      // siblings whenever their content/line-height differed. Assert all
      // three now pin an explicit, EQUAL `height` (not merely `min-height`)
      // from the SAME shared token, so none can outgrow or undershoot the
      // others regardless of flex stretch/content differences.
      for (const block of [priorityChipBlock, executionToggleBlock, oversightTriggerBlock]) {
        expect(block).toContain("height: var(--detail-priority-control-min-height);");
        expect(block).toContain("min-height: var(--detail-priority-control-min-height);");
        expect(block).toContain("box-sizing: border-box;");
      }

      // Guard against a future regression reintroducing a second, independent
      // literal height source (e.g. a hardcoded px height) instead of reusing
      // the shared token.
      expect(css).not.toMatch(/\.detail-priority-chip\s*\{[^}]*height:\s*\d+px/);
      expect(css).not.toMatch(/\.detail-execution-mode-toggle\s*\{[^}]*height:\s*\d+px/);
      expect(css).not.toMatch(/\.detail-oversight-menu-trigger\s*\{[^}]*height:\s*\d+px/);

      // The fixed height must hold at non-mobile widths (the reported
      // symptom) — the base (non-media-scoped) rules above already assert
      // this since `getExactCssRuleBlock` matches the top-level selector, not
      // one nested in a media query.

      // No `@media (max-width: 768px)` override redefines any of the three
      // selectors with a diverging `height`, so the mobile wrap fallback
      // keeps all three controls the same height too.
      for (const selector of [".detail-priority-chip", ".detail-execution-mode-toggle", ".detail-oversight-menu-trigger"]) {
        const mobileSelectorBlock = getExactCssRuleBlock(mobileBlock, selector);
        expect(mobileSelectorBlock).toBe("");
      }

      // The popover itself must remain untouched by the height fix — still
      // absolutely positioned, no explicit height forcing it to stretch.
      expect(oversightMenuBlock).toContain("position: absolute;");
      expect(oversightMenuBlock).not.toMatch(/^\s*height:/m);
    });

    it.skip("renders the Priority dropdown chip like the Oversight dropdown chip, on every surface (FN-7597)", () => {
      const css = readDashboardStylesSource();

      const priorityChipBlock = getExactCssRuleBlock(css, ".detail-priority-chip");
      const oversightTriggerBlock = getExactCssRuleBlock(css, ".detail-oversight-menu-trigger");
      const prioritySelectBlock = getExactCssRuleBlock(css, ".detail-priority-select");
      const oversightSelectBlock = getExactCssRuleBlock(css, ".detail-oversight-select");
      const prioritySelectOptionBlock = getExactCssRuleBlock(css, ".detail-priority-select option");
      const oversightSelectOptionBlock = getExactCssRuleBlock(css, ".detail-oversight-select option");

      // Same box size AND same border source for the Priority chip vs. the
      // (now-universal, FN-7604) Oversight overflow trigger.
      for (const block of [priorityChipBlock, oversightTriggerBlock]) {
        expect(block).toContain("min-height: var(--detail-priority-control-min-height);");
        expect(block).toContain("border-width: var(--btn-border-width);");
        expect(block).toContain("border-color: var(--border);");
        expect(block).toContain("border-radius: var(--detail-control-border-radius);");
        expect(block).toContain("box-sizing: border-box;");
      }

      // Same select typography: neither select force-uppercases its own text
      // or options; both rely on the ancestor chip label's uppercase transform,
      // so a regression re-adding a Priority-only override fails this.
      expect(prioritySelectBlock).not.toMatch(/text-transform\s*:/);
      expect(oversightSelectBlock).not.toMatch(/text-transform\s*:/);
      expect(prioritySelectOptionBlock).not.toMatch(/text-transform\s*:/);
      expect(oversightSelectOptionBlock).not.toMatch(/text-transform\s*:/);
      expect(prioritySelectBlock).toContain("font: inherit;");
      expect(oversightSelectBlock).toContain("font: inherit;");

      // The untinted `normal` priority level must resolve a real, non-transparent
      // neutral chip background (not a borderless/background-less shell), just
      // like the Oversight chip's neutral `--off` background.
      const priorityNormalBlock = getExactCssRuleBlock(css, ".detail-priority-chip.card-priority-badge--normal");
      const oversightOffBlock = getExactCssRuleBlock(css, ".card-oversight-badge--off");
      expect(priorityNormalBlock).toMatch(/background:\s*color-mix\(in srgb, var\(--text-muted\)/);
      expect(oversightOffBlock).toMatch(/background:\s*color-mix\(in srgb, var\(--text-muted\)/);

      // The semantic priority tints (info/warning/error family) must survive —
      // this task must not flatten low/high/urgent to the same neutral tone.
      expect(css).toMatch(/\.card-priority-badge--low\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--color-info\)/);
      expect(css).toMatch(/\.card-priority-badge--high\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--color-warning\)/);
      expect(css).toMatch(/\.card-priority-badge--urgent\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--color-error\)/);

      // `--saving` only dims opacity; it must never change box size/border.
      const prioritySavingBlock = getExactCssRuleBlock(css, ".detail-priority-chip--saving");
      expect(prioritySavingBlock.replace(/\s+/g, "")).toBe("opacity:0.75;");
      expect(prioritySavingBlock).not.toMatch(/border|min-height|padding/);
    });

    it.skip("makes low/high/urgent visibly distinct colors on the detail Priority chip, scoped away from TaskCard (FN-7601)", () => {
      const css = readDashboardStylesSource();

      // FN-7585's shared base rule and FN-7597's neutral `normal` rule must
      // survive untouched — this task only ADDS per-level overrides on top.
      const baseChipBlock = getExactCssRuleBlock(css, ".detail-priority-chip");
      expect(baseChipBlock).toContain("border-width: var(--btn-border-width);");
      expect(baseChipBlock).toContain("border-color: var(--border);");
      expect(baseChipBlock).toContain("border-radius: var(--detail-control-border-radius);");
      const normalBlock = getExactCssRuleBlock(css, ".detail-priority-chip.card-priority-badge--normal");
      expect(normalBlock).toMatch(/background:\s*color-mix\(in srgb, var\(--text-muted\)/);
      expect(normalBlock).toContain("color: var(--text-muted);");

      const lowBlock = getExactCssRuleBlock(css, ".detail-priority-chip.card-priority-badge--low");
      const highBlock = getExactCssRuleBlock(css, ".detail-priority-chip.card-priority-badge--high");
      const urgentBlock = getExactCssRuleBlock(css, ".detail-priority-chip.card-priority-badge--urgent");

      // Each non-neutral level must declare its own tinted border-color AND
      // background, using the matching semantic token family.
      for (const [block, token] of [
        [lowBlock, "--color-info"],
        [highBlock, "--color-warning"],
        [urgentBlock, "--color-error"],
      ] as const) {
        expect(block).not.toBe("");
        expect(block).toMatch(/border-color\s*:/);
        expect(block).toMatch(/background\s*:/);
        expect(block).toContain(token);
      }

      // None of the per-level border-colors may resolve to the plain shared
      // `var(--border)` value used by the base rule — that was the original
      // bug (every level looked the same washed-out box).
      const borderColorOf = (block: string): string => {
        const match = block.match(/border-color\s*:\s*([^;]+);/);
        return match?.[1]?.trim() ?? "";
      };
      const backgroundOf = (block: string): string => {
        const match = block.match(/background\s*:\s*([^;]+);/);
        return match?.[1]?.trim() ?? "";
      };

      const lowBorder = borderColorOf(lowBlock);
      const highBorder = borderColorOf(highBlock);
      const urgentBorder = borderColorOf(urgentBlock);

      expect(lowBorder).not.toBe("var(--border)");
      expect(highBorder).not.toBe("var(--border)");
      expect(urgentBorder).not.toBe("var(--border)");

      // Mutually distinct — low, high, and urgent must not collapse onto the
      // same border-color or background declaration as one another.
      expect(new Set([lowBorder, highBorder, urgentBorder]).size).toBe(3);
      const lowBg = backgroundOf(lowBlock);
      const highBg = backgroundOf(highBlock);
      const urgentBg = backgroundOf(urgentBlock);
      expect(new Set([lowBg, highBg, urgentBg]).size).toBe(3);

      // `normal`'s background/border must remain distinct from all three tinted
      // levels (it keeps the FN-7597 neutral treatment, not a semantic tint).
      expect(new Set([backgroundOf(normalBlock), lowBg, highBg, urgentBg]).size).toBe(4);

      // The read-only TaskCard badge tints referenced by TaskCard.css must be
      // untouched by this task — confirm no `.detail-priority-chip` compound
      // selector leaks a border-color override into the bare `.card-priority-badge--*`
      // selectors (those remain single-class, background/color-only rules).
      expect(css).toMatch(/\.card-priority-badge--low\s*\{\s*background:\s*color-mix\(in srgb, var\(--color-info\) 15%, transparent\);\s*color:\s*var\(--color-info\);\s*\}/);
      expect(css).toMatch(/\.card-priority-badge--high\s*\{\s*background:\s*color-mix\(in srgb, var\(--color-warning\) 18%, transparent\);\s*color:\s*var\(--color-warning\);\s*\}/);
      expect(css).toMatch(/\.card-priority-badge--urgent\s*\{\s*background:\s*color-mix\(in srgb, var\(--color-error\) 20%, transparent\);\s*color:\s*var\(--color-error-dark\);\s*\}/);
    });

    it("keeps grouped timestamp metadata inline on desktop and mobile", () => {
      const css = readDashboardStylesSource();

      expectBaseRule(css, ".detail-timestamps", "display: inline-flex;");
      expectBaseRule(css, ".detail-timestamps", "flex-wrap: nowrap;");
      expectBaseRule(css, ".detail-timestamp-item", "display: inline-flex;");
      expectBaseRule(css, ".detail-timestamp-separator", "color: var(--text-dim);");

      expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.detail-timestamps\s*\{[^}]*align-items:\s*center;[^}]*flex-wrap:\s*nowrap;/);
      expect(css).not.toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.detail-timestamps\s*\{[^}]*flex-direction:\s*column;/);
      expect(css).toContain(".task-detail-content--planner-chat-expanded .detail-timestamps .detail-timestamp-separator");
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
    it("keeps desktop and mobile modal sizing guards unchanged", () => {
      const css = readDashboardStylesSource();
      const mobileBlock = getCssAtRuleBlockContaining(css, "@media (max-width: 768px)", ".modal-overlay:has(.task-detail-modal)");
      const mobileOverlayBlock = getCssRuleBlock(mobileBlock, ".modal-overlay:has(.task-detail-modal)");
      const mobileModalBlock = getCssRuleBlock(mobileBlock, ".modal.task-detail-modal");

      expectBaseRule(css, ".modal.task-detail-modal", "width: min(95vw, 800px);");
      expectBaseRule(css, ".modal.task-detail-modal", "height: 85vh;");
      expect(mobileOverlayBlock).toContain("padding-top: 0;");
      expect(mobileOverlayBlock).toContain("align-items: stretch;");
      expect(mobileModalBlock).toContain("width: 100vw;");
      expect(mobileModalBlock).toContain("height: 100dvh;");
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
      expect(css).toContain(".detail-activity {\n  position: relative;\n  padding-inline-end: calc(var(--space-2xl) + var(--space-md));\n}");
      expect(overlayBlock).toContain("position: absolute;");
      expect(overlayBlock).toContain("top: var(--space-md);");
      expect(overlayBlock).toContain("right: var(--space-md);");
      expect(mobileBlock).toContain("  .detail-activity {\n    padding-inline-end: 0;\n  }");
      expect(mobileOverlayBlock).toContain("top: var(--space-sm);");
      expect(mobileOverlayBlock).toContain("right: var(--space-sm);");

      /*
      FNXC:TaskDetailActivity 2026-07-16-00:00:
      FN-8166 requires Feed to inherit the symmetric mobile `.detail-body` inset,
      while only its first visible row reserves space for the opaque overlay toggle.
      This contract also prevents non-Feed task-detail surfaces from adding a
      container-level right-only inset or mobile horizontal overflow.
      */
      const mobileDetailBodyBlock = getExactCssRuleBlock(mobileBlock, ".detail-body");
      const mobileInterventionsBlock = getExactCssRuleBlock(mobileBlock, ".detail-activity--interventions");
      const mobilePrBlock = getExactCssRuleBlock(
        getCssAtRuleBlockContainingExactRule(css, "@media (max-width: 768px)", ".detail-pr-tab"),
        ".detail-pr-tab",
      );
      const embeddedBodyBlock = getExactCssRuleBlock(
        css,
        ".task-detail-content--embedded .modal-header,\n.task-detail-content--embedded .detail-body,\n.task-detail-content--embedded .detail-tabs,\n.task-detail-content--embedded .modal-actions",
      );
      const allMobileCss = getCssAtRuleBlocks(css, "@media (max-width: 768px)").join("\n");

      expect(mobileDetailBodyBlock).toContain("padding: calc(var(--space-md) + var(--space-xs) / 2);");
      expect(mobileDetailBodyBlock).toContain("overflow-x: hidden;");
      expect(mobileInterventionsBlock).toContain("padding-inline-end: 0;");
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
      const mobileScrollbarBlock = getExactCssRuleBlock(mobileBlock, ".detail-body::-webkit-scrollbar");
      const mobileActivityBlock = getExactCssRuleBlock(mobileBlock, ".detail-activity");
      const mobileInterventionsBlock = getExactCssRuleBlock(mobileBlock, ".detail-activity--interventions");
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
      expect(mobileDetailBodyBlock).toContain("padding: calc(var(--space-md) + var(--space-xs) / 2);");
      expect(mobileDetailBodyBlock).toContain("overflow-x: hidden;");
      expect(mobileDetailBodyBlock).toContain("overflow-y: auto;");
      expect(mobileDetailBodyBlock).toContain("scrollbar-width: none;");
      expect(mobileScrollbarBlock).toContain("display: none;");

      expect(mobileActivityBlock).toContain("padding-inline-end: 0;");
      expect(mobileBlock).toContain("padding-inline-end: calc(var(--space-2xl) + var(--space-sm));");
      expect(mobileInterventionsBlock).toContain("padding-inline-end: 0;");
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

    it("renders responsive structural classes (modal-lg, overlay, spacer, tabs, detail-body)", () => {
      const { container } = render(
        <TaskDetailModal
          task={makeTask({ column: "in-progress" as Column })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      expect(container.querySelector(".modal.modal-lg")).toBeTruthy();
      expect(container.querySelector(".modal-overlay.open")).toBeTruthy();
      expect(container.querySelector(".modal-actions .modal-actions-spacer")).toBeTruthy();
      expect(container.querySelector(".detail-body")).toBeTruthy();
      expect(container.querySelector(".detail-timestamps")).toBeTruthy();
      expect(container.querySelectorAll(".detail-timestamp-item").length).toBe(2);
      const tabs = container.querySelectorAll(".detail-tab");
      // FNXC:TaskDetailTabs 2026-07-15-23:23: Keep this responsive-order expectation aligned with peer tab tests: the always-available Terminal (FN-7826) and Cost (FN-7820) tabs belong between Comments and Artifacts.
      expect(Array.from(tabs).map((tab) => tab.textContent?.trim())).toEqual([
        "Activity",
        "Chat",
        "Plan",
        "Changes",
        "Review",
        "Comments",
        "Terminal",
        "Cost",
        "Artifacts",
        "Model",
        "Workflow",
        "Stats",
        "Routing",
      ]);
      expect(tabs[0].classList.contains("detail-tab-active")).toBe(true);
      expect(Array.from(tabs).slice(1).every((t) => !t.classList.contains("detail-tab-active"))).toBe(true);
      // Responsive CSS controls sizing — no inline padding/fontSize/borderBottom leaks
      expect((tabs[0] as HTMLElement).style.padding).toBe("");
      expect((tabs[0] as HTMLElement).style.fontSize).toBe("");
      expect((container.querySelector(".detail-tabs") as HTMLElement).style.borderBottom).toBe("");
    });

    it("modal-actions contains Delete and Pause buttons for non-done tasks (via Actions dropdown)", () => {
      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-progress" as Column })}
          onClose={noop}
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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

    it("offers archive instead when deleting a non-done live task", async () => {
      const onArchiveTask = vi.fn().mockResolvedValue({} as Task);
      mockConfirmWithChoice.mockResolvedValueOnce("tertiary");

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "todo" as any })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onArchiveTask={onArchiveTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onArchiveTask).toHaveBeenCalledWith("FN-099");
      });
      expect(noopDelete).not.toHaveBeenCalled();
    });

    it("retries archive after lineage-conflict confirmation", async () => {
      const onArchiveTask = vi.fn();
      const conflict = new Error("Cannot archive task FN-099: still referenced as a lineage parent by FN-201.") as Error & {
        status: number;
        details: { code: string; lineageChildIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-201"] };
      onArchiveTask
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({} as Task);
      mockConfirmWithChoice.mockResolvedValueOnce("tertiary");
      mockConfirm.mockResolvedValueOnce(true);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "done" as any })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onArchiveTask={onArchiveTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onArchiveTask).toHaveBeenNthCalledWith(2, "FN-099", { removeLineageReferences: true });
      });
    });

    it("does not retry archive when lineage-force confirmation is canceled", async () => {
      const onArchiveTask = vi.fn();
      const conflict = new Error("Cannot archive task FN-099: still referenced as a lineage parent by FN-202.") as Error & {
        status: number;
        details: { code: string; lineageChildIds: string[] };
      };
      conflict.status = 409;
      conflict.details = { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-202"] };
      onArchiveTask.mockRejectedValue(conflict);
      mockConfirmWithChoice.mockResolvedValueOnce("tertiary");
      mockConfirm.mockResolvedValueOnce(false);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "done" as any })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onArchiveTask={onArchiveTask}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => {
        expect(onArchiveTask).toHaveBeenCalledTimes(1);
        expect(mockConfirm).toHaveBeenCalledTimes(1);
      });
    });

    it("in-review modal-actions contains Merge & Close and Back to In Progress buttons", () => {
      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-review" as Column })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Merge & Close")).toBeTruthy();

      // Back to In Progress is in secondary move options
      fireEvent.click(document.querySelector(".detail-move-btn__arrow")!);
      expect(screen.getByRole("menuitem", { name: "Back to In Progress" })).toBeTruthy();
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
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
          initialTab="definition"
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
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(summary.container.querySelector(".merge-details-card a")).toHaveAttribute("href", "https://github.com/owner/repo/pull/42");
      summary.unmount();

      render(
        <TaskDetailModal
          initialTab="definition"
          task={task}
          onClose={noop}
          onMoveTask={noopMove}
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
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const button = screen.getByText("Awaiting PR checks") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(screen.queryByText("Merge & Close")).toBeNull();
    });

    it("shows Creating PR label while PR-first automation is creating a PR", () => {
      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-review" as Column, status: "creating-pr" })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const button = screen.getByText("Creating PR…") as HTMLButtonElement;
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
          initialTab="definition"
          task={makeTask(taskOverrides)}
          tasks={searchTasks}
          onClose={noop}
          onMoveTask={noopMove}
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

  describe("clickable dependency links", () => {
    it("renders dependency list items with clickable class and ID + label", () => {
      // Provide tasks prop to enable title lookup
      const allTasks: Task[] = [
        { id: "FN-001", title: "Fix login bug", description: "Login broken", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
        { id: "FN-002", title: "Add tests", description: "Test coverage", column: "todo" as Column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" },
      ];

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ dependencies: ["FN-001", "FN-002"] })}
          tasks={allTasks}
          onClose={noop}
          onMoveTask={noopMove}
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

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ dependencies: ["FN-001"] })}
          tasks={allTasks}
          onClose={noop}
          onMoveTask={noopMove}
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
      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ dependencies: ["FN-001"] })}
          // No tasks prop - dependency not found
          onClose={noop}
          onMoveTask={noopMove}
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

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ dependencies: ["FN-001"] })}
          tasks={allTasks}
          onClose={noop}
          onMoveTask={noopMove}
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

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ dependencies: ["FN-001"] })}
          tasks={allTasks}
          onClose={noop}
          onMoveTask={noopMove}
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

    it("calls fetchTaskDetail and onOpenDetail when clicking a dependency", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      const mockDetail: TaskDetail = {
        ...makeTask({ id: "FN-001", description: "Dep 1" }),
        prompt: "",
        attachments: [],
      };
      mockFetch.mockResolvedValueOnce(mockDetail);
      const onOpenDetail = vi.fn();

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ dependencies: ["FN-001"] })}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      const depLink = container.querySelector(".detail-dep-link")!;
      fireEvent.click(depLink);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith("FN-001", undefined);
        expect(onOpenDetail).toHaveBeenCalledWith(mockDetail);
      });
    });

    it("shows error toast when dependency fetch fails", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      mockFetch.mockRejectedValueOnce(new Error("Task not found"));
      const onOpenDetail = vi.fn();
      const addToast = vi.fn();

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ dependencies: ["FN-001"] })}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={addToast}
        />,
      );

      const depLink = container.querySelector(".detail-dep-link")!;
      fireEvent.click(depLink);

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Failed to load dependency FN-001", "error");
      });
      expect(onOpenDetail).not.toHaveBeenCalled();
    });

    it("remove button click does not trigger dependency click", async () => {
      const { updateTask } = await import("../../api");
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      mockFetch.mockRejectedValueOnce(new Error("Should not be called"));
      const onOpenDetail = vi.fn();

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ dependencies: ["FN-001"] })}
          onOpenDetail={onOpenDetail}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          addToast={noop}
        />,
      );

      const removeButton = screen.getByTitle(/Remove dependency/);
      fireEvent.click(removeButton);

      // onOpenDetail should not be called when clicking remove
      expect(onOpenDetail).not.toHaveBeenCalled();
      // updateTask should be called to remove the dependency
      await waitFor(() => {
        expect(updateTask).toHaveBeenCalledWith("FN-099", { dependencies: [] }, undefined);
      });
    });
  });

  describe("blocking section", () => {
    it("renders downstream dependents and stale annotations", () => {
      const tasks = [
        makeTask({ id: "FN-099", title: "Blocker", column: "done" as Column }),
        makeTask({ id: "FN-100", title: "Todo dependent", column: "todo" as Column, dependencies: ["FN-099"] }),
        makeTask({ id: "FN-101", title: "Stale blockedBy dependent", column: "todo" as Column, blockedBy: "FN-099" }),
      ];

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={tasks[0]}
          tasks={tasks}
          onOpenDetail={noopOpenDetail}
          onClose={noop}
          onMoveTask={noopMove}
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


  it("keeps icon-only toolbar controls in a wrapping mobile row", () => {
    const css = readDashboardStylesSource();
    const mobileBlock = getCssAtRuleBlockContaining(css, "@media (max-width: 768px)", ".detail-meta-inline-controls");
    expectBaseRule(css, ".detail-meta-inline-controls", "flex-wrap: nowrap;");
    expect(mobileBlock).toMatch(/\.detail-meta-inline-controls\s*\{[^}]*flex-wrap:\s*wrap;/);
    expect(mobileBlock).not.toMatch(/flex-direction:\s*column/);
    expect(css).not.toMatch(/\.detail-oversight-menu-trigger svg\s*\{[^}]*width:\s*1em/);
  });

});
