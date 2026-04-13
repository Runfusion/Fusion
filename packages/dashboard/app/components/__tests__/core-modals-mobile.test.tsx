import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const stylesPath = path.resolve(__dirname, "../../styles.css");

function getMainMobileBlock(css: string): string {
  const mobileSectionStart = css.indexOf("/* === Mobile Responsive Overrides ===");
  const tabletSectionStart = css.indexOf("/* === Tablet Responsive Tier", mobileSectionStart);

  expect(mobileSectionStart).toBeGreaterThan(-1);
  expect(tabletSectionStart).toBeGreaterThan(mobileSectionStart);

  const block = css.slice(mobileSectionStart, tabletSectionStart);
  expect(block).toContain("@media (max-width: 768px)");
  expect(block).toContain(".modal-overlay");
  expect(block).toContain(".detail-tabs");

  return block;
}

describe("core modals mobile css coverage", () => {
  it("TaskDetailModal: modal-actions uses safe-area inset bottom padding", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".modal-actions {");
    expect(mobileBlock).toContain("env(safe-area-inset-bottom, 0px)");
  });

  it("TaskDetailModal: detail tabs are horizontally scrollable and tabs do not shrink", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".detail-tabs {");
    expect(mobileBlock).toContain("overflow-x: auto;");
    expect(mobileBlock).toContain(".detail-tab {");
    expect(mobileBlock).toContain("flex-shrink: 0;");
  });

  it("TaskDetailModal: refine modal goes full-screen on mobile", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".detail-refine-modal {");
    expect(mobileBlock).toContain("width: 100%;");
    expect(mobileBlock).toContain("max-width: 100%;");
  });

  it("NewTaskModal: modal body unsets desktop max-height for mobile", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".new-task-modal .modal-body {");
    expect(mobileBlock).toContain("max-height: unset;");
    expect(mobileBlock).toContain("overflow-y: auto;");
  });

  it("TaskForm: model selection rows stack vertically on mobile", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".model-select-row {");
    expect(mobileBlock).toContain("flex-direction: column;");
    expect(mobileBlock).toContain(".model-select-label {");
    expect(mobileBlock).toContain("width: auto;");
    expect(mobileBlock).toContain("text-align: left;");
  });

  it("SettingsModal: layout stacks and sidebar becomes horizontal scroll row", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
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
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".gm-layout {");
    expect(mobileBlock).toContain("flex-direction: column;");
    expect(mobileBlock).toContain(".gm-sidebar {");
    expect(mobileBlock).toContain("flex-direction: row;");
  });

  it("GitManagerModal: nav items keep 36px touch target on mobile", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".gm-nav-item {");
    expect(mobileBlock).toContain("min-height: 36px;");
  });

  it("TaskDetailModal: action dropdown menus have max-height constraint on mobile", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
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
  });
});
