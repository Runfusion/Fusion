import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = loadAllAppCss();

function extractMaxWidthMediaBlocks(maxWidthPx: number): string[] {
  const marker = `@media (max-width: ${maxWidthPx}px)`;
  const blocks: string[] = [];
  let fromIndex = 0;

  while (fromIndex < css.length) {
    const mediaStart = css.indexOf(marker, fromIndex);
    if (mediaStart === -1) {
      break;
    }

    const openBrace = css.indexOf("{", mediaStart);
    if (openBrace === -1) {
      break;
    }

    let depth = 0;
    let closeBrace = -1;

    for (let i = openBrace; i < css.length; i += 1) {
      const ch = css[i];
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          closeBrace = i;
          break;
        }
      }
    }

    if (closeBrace === -1) {
      throw new Error(`Unclosed @media block starting at index ${mediaStart}`);
    }

    blocks.push(css.slice(mediaStart, closeBrace + 1));
    fromIndex = closeBrace + 1;
  }

  return blocks;
}

const mobileBlocks = extractMaxWidthMediaBlocks(768);

function findMobileBlockContaining(needle: string): string {
  const block = mobileBlocks.find((candidate) => candidate.includes(needle));
  expect(block, `Expected a 768px mobile block containing "${needle}"`).toBeTruthy();
  return block ?? "";
}

describe("mission + planning modal mobile CSS", () => {
  it("MissionManager: mission icon button touch targets are 36px", () => {
    const missionBlock = findMobileBlockContaining(".mission-manager-overlay");
    expect(missionBlock).toMatch(/\.mission-list__item-actions \.mission-icon-btn,[\s\S]*?\.mission-feature__actions \.mission-icon-btn\s*\{[\s\S]*?min-width:\s*36px;[\s\S]*?min-height:\s*36px;/s);
  });

  it("MissionManager: body prevents horizontal overflow", () => {
    const missionBlock = findMobileBlockContaining(".mission-manager-overlay");
    expect(missionBlock).toMatch(/\.mission-manager__body\s*\{[^}]*overflow-x:\s*hidden;/s);
  });

  it("MissionManager: feature actions wrap", () => {
    const missionBlock = findMobileBlockContaining(".mission-manager-overlay");
    expect(missionBlock).toMatch(/\.mission-feature__actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
  });

  it("MissionManager: detail view includes safe-area bottom padding", () => {
    const missionBlock = findMobileBlockContaining(".mission-manager-overlay");
    expect(missionBlock).toMatch(/\.mission-detail\s*\{[^}]*env\(safe-area-inset-bottom/s);
  });

  it("SubtaskBreakdown: drag handle is touch-friendly (36px)", () => {
    const planningBlock = findMobileBlockContaining(".planning-modal");
    expect(planningBlock).toMatch(/\.subtask-drag-handle\s*\{[^}]*min-width:\s*36px;[^}]*min-height:\s*36px;/s);
  });

  it("SubtaskBreakdown: subtask action icon buttons are 36px", () => {
    const planningBlock = findMobileBlockContaining(".planning-modal");
    expect(planningBlock).toMatch(/\.subtask-item-actions \.btn-icon\s*\{[^}]*min-width:\s*36px;[^}]*min-height:\s*36px;/s);
  });

  it("SubtaskBreakdown: dependency chips are touch-friendly", () => {
    const planningBlock = findMobileBlockContaining(".planning-modal");
    expect(planningBlock).toMatch(/\.planning-dep-chip\s*\{[^}]*min-height:\s*36px;/s);
  });

  it("PlanningMode: confirm buttons meet touch targets", () => {
    const planningBlock = findMobileBlockContaining(".planning-modal");
    expect(planningBlock).toMatch(/\.planning-confirm-btn\s*\{[^}]*min-height:\s*36px;/s);
  });

  it("ModelSelection: combobox dropdown has mobile sizing", () => {
    const modelBlock = findMobileBlockContaining(".model-combobox-dropdown");
    expect(modelBlock).toMatch(/\.model-combobox-dropdown\s*\{[^}]*max-height:\s*50vh;[^}]*width:\s*min\(360px,\s*calc\(100vw - 32px\)\);/s);
  });

  it("ModelSelection: combobox search input is 16px on mobile", () => {
    const modelBlock = findMobileBlockContaining(".model-combobox-search");
    expect(modelBlock).toMatch(/\.model-combobox-search\s*\{[^}]*font-size:\s*16px;/s);
  });

  it("All planning modals: textareas are 16px to prevent iOS zoom", () => {
    const planningBlock = findMobileBlockContaining(".planning-modal");
    const hasPlanningTextarea = /\.planning-textarea\s*\{[^}]*font-size:\s*16px;/s.test(planningBlock);
    const hasPlanningSummaryForm = /\.planning-summary-form[\s\S]*font-size:\s*16px;/s.test(planningBlock);
    expect(hasPlanningTextarea || hasPlanningSummaryForm).toBe(true);
  });

  it("Planning modal: footer actions stack vertically on mobile", () => {
    const planningBlock = findMobileBlockContaining(".planning-modal");
    expect(planningBlock).toMatch(/\.planning-actions\s*\{[^}]*flex-direction:\s*column;/s);
  });

  it("ModelSelection: combobox options meet touch targets", () => {
    const modelBlock = findMobileBlockContaining(".model-combobox-option");
    expect(modelBlock).toMatch(/\.model-combobox-option\s*\{[^}]*min-height:\s*36px;/s);
  });
});
