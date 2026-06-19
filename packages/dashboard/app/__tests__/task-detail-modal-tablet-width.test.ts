import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("task detail modal tablet width (FN-5599, FN-6500)", () => {
  const detailModalCss = readFileSync(
    resolve(__dirname, "../components/TaskDetailModal.css"),
    "utf-8",
  );

  it("keeps desktop base width rule unchanged", () => {
    const baseRuleMatch = detailModalCss.match(/\.modal\.task-detail-modal\s*\{[^}]*\}/s);
    expect(baseRuleMatch).toBeTruthy();
    expect(baseRuleMatch![0]).toContain("width: min(95vw, 800px);");
  });

  it("defines a tablet breakpoint override for task detail modal width and height coupling", () => {
    const tabletBlockMatch = detailModalCss.match(
      /@media\s*\(min-width:\s*769px\)\s*and\s*\(max-width:\s*1024px\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(tabletBlockMatch).toBeTruthy();

    const tabletBlock = tabletBlockMatch![1];
    const overlayRuleMatch = tabletBlock.match(/\.modal-overlay:has\(\.task-detail-modal\)\s*\{[^}]*\}/s);
    const modalRuleMatch = tabletBlock.match(/\.modal\.task-detail-modal\s*\{[^}]*\}/s);
    const overlayOffset = overlayRuleMatch?.[0].match(/--overlay-padding-top:\s*([^;]+);/)?.[1]?.trim();
    const maxHeightOffset = modalRuleMatch?.[0].match(/max-height:\s*calc\(100dvh - var\(--overlay-padding-top,\s*([^)]+)\) - var\(--space-md\)\);/)?.[1]?.trim();

    expect(overlayRuleMatch).toBeTruthy();
    expect(modalRuleMatch).toBeTruthy();
    expect(maxHeightOffset).toBe(overlayOffset);
    expect(modalRuleMatch![0]).toContain("width: 98vw;");
    expect(modalRuleMatch![0]).toContain("max-width: 98vw;");
  });

  it("keeps mobile full-screen sheet width behavior", () => {
    const mobileBlockMatch = detailModalCss.match(
      /@media\s*\(max-width:\s*768px\)\s*\{\s*\.detail-move-btn__arrow[\s\S]*?\.modal\.task-detail-modal\s*\{[^}]*\}[\s\S]*?\n\}/,
    );
    expect(mobileBlockMatch).toBeTruthy();

    const mobileBlock = mobileBlockMatch![0];
    const modalRuleMatch = mobileBlock.match(/\.modal\.task-detail-modal\s*\{[^}]*\}/s);
    expect(modalRuleMatch).toBeTruthy();
    expect(modalRuleMatch![0]).toContain("width: 100vw;");
  });
});
