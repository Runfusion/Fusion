import fs from "node:fs";
import { loadAllAppCss } from "../../test/cssFixture";
import path from "node:path";
import { describe, expect, it } from "vitest";


function getMainMobileBlock(css: string): string {
  // Mobile rules now live both in styles.css (cross-cutting) and in
  // co-located @media (max-width: 768px) blocks at the bottom of each
  // component CSS file. Aggregate all such media-query blocks.
  const matches = [...css.matchAll(/@media\s*\(max-width:\s*768px\)\s*\{/g)];
  expect(matches.length).toBeGreaterThan(0);

  const parts: string[] = [];
  for (const match of matches) {
    const start = match.index!;
    const open = css.indexOf("{", start);
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    parts.push(css.slice(start, i));
  }
  const block = parts.join("\n");
  expect(block).toContain(".modal-overlay");
  expect(block).toContain(".detail-tabs");
  return block;
}

describe("core modals mobile css coverage", () => {
  it("TaskDetailModal: modal-actions uses safe-area inset bottom padding", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".modal-actions {");
    expect(mobileBlock).toContain("env(safe-area-inset-bottom, 0px)");
  });

  it("TaskDetailModal: detail tabs are horizontally scrollable and tabs do not shrink", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".detail-tabs {");
    expect(mobileBlock).toContain("overflow-x: auto;");
    expect(mobileBlock).toContain(".detail-tab {");
    expect(mobileBlock).toContain("flex-shrink: 0;");
  });

  it("TaskDetailModal: refine modal goes full-screen on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".detail-refine-modal {");
    expect(mobileBlock).toContain("width: 100%;");
    expect(mobileBlock).toContain("max-width: 100%;");
  });

  it("NewTaskModal: modal body unsets desktop max-height for mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".new-task-modal .modal-body {");
    expect(mobileBlock).toContain("max-height: unset;");
    expect(mobileBlock).toContain("overflow-y: auto;");
  });

  it("TaskForm: model selection rows stack vertically on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".model-select-row {");
    expect(mobileBlock).toContain("flex-direction: column;");
    expect(mobileBlock).toContain(".model-select-label {");
    expect(mobileBlock).toContain("width: auto;");
    expect(mobileBlock).toContain("text-align: left;");
  });

  it("SettingsModal: layout stacks and sidebar becomes horizontal scroll row", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".settings-layout {");
    expect(mobileBlock).toContain("flex-direction: column;");
    expect(mobileBlock).toContain(".settings-sidebar {");
    expect(mobileBlock).toContain("flex-direction: row;");
    expect(mobileBlock).toContain("align-items: center;");
    expect(mobileBlock).toContain("overflow-x: auto;");
    expect(mobileBlock).toContain(".settings-nav-item {");
    expect(mobileBlock).toContain("display: flex;");
    expect(mobileBlock).toContain("align-items: center;");
    expect(mobileBlock).toContain("justify-content: center;");
    expect(mobileBlock).toContain("gap: 4px;");
  });

  it("GitManagerModal: 768px mobile block includes stacked layout rules", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".gm-layout {");
    expect(mobileBlock).toContain("flex-direction: column;");
    expect(mobileBlock).toContain(".gm-sidebar {");
    expect(mobileBlock).toContain("flex-direction: row;");
  });

  it("GitManagerModal: nav items keep 36px touch target on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".gm-nav-item {");
    expect(mobileBlock).toContain("min-height: 36px;");
  });

  it("GitManagerModal: panel allows content scrolling on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".gm-panel {");
    expect(mobileBlock).toContain("overflow-y: auto;");
  });

  it("GitManagerModal: modal uses full-screen viewport sizing on mobile (641-768px range)", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    // Verify .gm-modal is included in the modal sizing rule block
    const modalRuleMatch = mobileBlock.match(
      /\.modal,\s*\.modal-lg,\s*\.modal-md,\s*\.gm-modal\s*\{[^}]+\}/,
    );
    expect(modalRuleMatch).not.toBeNull();
    const modalRule = modalRuleMatch![0];

    // Verify full-screen constraints
    expect(modalRule).toContain("width: 100%;");
    expect(modalRule).toContain("max-width: 100%;");
    expect(modalRule).toContain("height: 100vh;");
    expect(modalRule).toContain("max-height: 100vh;");
    expect(modalRule).toContain("border-radius: 0;");
  });

  it("TaskDetailModal: action dropdown menus have max-height constraint on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    // Verify dropdown menu selectors are in mobile block (selectors share the same line)
    expect(mobileBlock).toContain(".detail-actions-menu,");
    expect(mobileBlock).toContain(".detail-move-menu {");

    // Extract the dropdown menu rule block and verify constraints
    const menuBlockMatch = mobileBlock.match(
      /\.detail-actions-menu,\s*\.detail-move-menu\s*\{[^}]+\}/s,
    );
    expect(menuBlockMatch).not.toBeNull();
    const menuBlock = menuBlockMatch![0];

    expect(menuBlock).toContain("max-height");
    expect(menuBlock).toContain("overflow-y: auto");
    expect(menuBlock).toContain("max-width: calc(100vw - 28px)");
  });

  it("TaskDetailModal: footer dropdown menus anchor toward available horizontal space", () => {
    const css = loadAllAppCss();

    const actionsMenuAnchorMatch = css.match(/^\.detail-actions-menu\s*\{\s*left: 0;\s*\}/m);
    const moveMenuAnchorMatch = css.match(/^\.detail-move-menu\s*\{\s*right: 0;\s*\}/m);
    expect(actionsMenuAnchorMatch).not.toBeNull();
    expect(moveMenuAnchorMatch).not.toBeNull();
  });

  it("TaskForm / TaskEditModal: description textarea capped at 200px height with scroll on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    // Modal edit form textarea (TaskEditModal)
    const modalEditBlockMatch = mobileBlock.match(
      /\.modal-edit-form \.form-group textarea\s*\{[^}]+\}/,
    );
    expect(modalEditBlockMatch).not.toBeNull();
    expect(modalEditBlockMatch![0]).toContain("max-height: 200px");
    expect(modalEditBlockMatch![0]).toContain("overflow-y: auto");
    expect(modalEditBlockMatch![0]).toContain("-webkit-overflow-scrolling: touch");

    // TaskForm description textarea
    const taskFormBlockMatch = mobileBlock.match(
      /\.task-form-primary-section \.description-with-refine textarea\s*\{[^}]+\}/,
    );
    expect(taskFormBlockMatch).not.toBeNull();
    expect(taskFormBlockMatch![0]).toContain("max-height: 200px");
    expect(taskFormBlockMatch![0]).toContain("overflow-y: auto");

    // Fullscreen variant restores unbounded height on mobile
    const fullscreenBlockMatch = mobileBlock.match(
      /\.task-form-primary-section \.description-with-refine\.description--fullscreen textarea\s*\{[^}]+\}/,
    );
    expect(fullscreenBlockMatch).not.toBeNull();
    expect(fullscreenBlockMatch![0]).toContain("max-height: unset");
  });

  it("NewTaskModal: quick fields buttons meet 36px touch target on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    // Verify the quick-fields dep-trigger rule exists with min-height: 36px
    const quickFieldsTriggerMatch = mobileBlock.match(
      /\.new-task-quick-fields \.dep-trigger\s*\{[^}]+\}/,
    );
    expect(quickFieldsTriggerMatch).not.toBeNull();
    expect(quickFieldsTriggerMatch![0]).toContain("min-height: 36px");
  });

  it("NewTaskModal: modal body uses token-based padding on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    // Extract the new-task-modal .modal-body rule
    const modalBodyMatch = mobileBlock.match(
      /\.new-task-modal \.modal-body\s*\{[^}]+\}/,
    );
    expect(modalBodyMatch).not.toBeNull();
    // Should use var(--space-sm) for horizontal padding (not hardcoded 0)
    expect(modalBodyMatch![0]).toContain("var(--space-sm)");
    expect(modalBodyMatch![0]).toContain("var(--space-md)");
  });

  it("NewTaskModal: more options toggle uses token-based margin on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    // Extract the more-options-toggle rule
    const toggleMatch = mobileBlock.match(
      /\.task-form-more-options-toggle\s*\{[^}]+\}/,
    );
    expect(toggleMatch).not.toBeNull();
    // Should use var(--space-md) for horizontal margin (not hardcoded 14px)
    expect(toggleMatch![0]).toContain("var(--space-md)");
  });
});
