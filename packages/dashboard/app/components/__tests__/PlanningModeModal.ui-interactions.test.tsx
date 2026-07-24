import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("PlanningModeModal sequential layout", () => {
  it("uses one persistent responsive plan-and-question workspace", () => {
    const css = readFileSync(resolve(process.cwd(), "app/components/PlanningModeModal.css"), "utf8");
    expect(css).not.toMatch(/planning-compact-pane-switcher|planning-answered-history/);
    expect(css).toContain("planning-workspace");
    expect(css).toContain('grid-template-areas: "question plan"');
    expect(css).toContain("planning-summary-actions");
  });

  it("captures selections only from the rendered plan and provides accessible comment controls", () => {
    const component = readFileSync(resolve(process.cwd(), "app/components/PlanningModeModal.tsx"), "utf8");
    expect(component).toContain("planDocumentRef.current");
    expect(component).toContain("root.contains(selection.anchorNode)");
    expect(component).toContain("root.contains(selection.focusNode)");
    expect(component).toContain('document.addEventListener("selectionchange", capturePlanSelection)');
    expect(component).toContain("selection.isCollapsed");
    expect(component).toContain("Add comment to selection");
    expect(component).toContain("planning-add-comment--document");
    expect(component).toContain("planning-add-comment--mobile");
    expect(component).toContain("mobileAddCommentTriggerRef");
    expect(component).toContain("contextualComments");
    expect(component).toContain("setContextualComments([])");
    // FNXC:PlanningComments 2026-07-24-06:20: prevent blur on pointerdown; commit on click.
    expect(component).toContain("handleMobileKeyboardActionPointerDown");
    expect(component).toContain("onPointerDown={handleMobileKeyboardActionPointerDown}");
    expect(component).toContain("onClick={handleAddContextualComment}");
    // FNXC:PlanningComments 2026-07-24-06:30: freeze quote on open so selection collapse cannot unmount the editor.
    expect(component).toContain("openCommentEditor");
    expect(component).toContain("openCommentQuote");
    expect(component).toContain("pendingOpenCommentQuoteRef");
  });

  it("keeps plan actions in a non-scrolling sibling footer with equal mobile columns", () => {
    const css = readFileSync(resolve(process.cwd(), "app/components/PlanningModeModal.css"), "utf8");
    expect(css).toMatch(/\.planning-actions\s*\{[^}]*flex-shrink\s*:\s*0\s*;/);
    expect(css).toMatch(/\.planning-plan-actions\s*\{[^}]*justify-content\s*:\s*flex-end\s*;[^}]*gap\s*:\s*var\(--space-lg\)\s*;[^}]*padding\s*:\s*var\(--space-md\) var\(--space-xl\) var\(--space-sm\)\s*;/);
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.planning-plan-actions\s*\{[^}]*display\s*:\s*grid\s*;[^}]*grid-template-columns\s*:\s*repeat\(2, minmax\(0, 1fr\)\)\s*;[^}]*gap\s*:\s*var\(--space-md\)\s*;[^}]*calc\(var\(--space-sm\) \+ env\(safe-area-inset-bottom\)\)/);
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.planning-plan-actions \.btn\s*\{[^}]*width\s*:\s*100%\s*;/);
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.planning-plan-actions\s*\{[^}]*gap\s*:\s*var\(--space-md\)\s*;[^}]*calc\(var\(--space-sm\) \+ env\(safe-area-inset-bottom\)\)/);
    expect(css).toMatch(/\.planning-add-comment--mobile\s*\{[^}]*display\s*:\s*none\s*;/);
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.planning-add-comment--document\s*\{[^}]*display\s*:\s*none\s*;/);
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.planning-plan-actions \.btn\.planning-add-comment--mobile\s*\{[^}]*display\s*:\s*flex\s*;[^}]*grid-column\s*:\s*1\s*\/\s*-1\s*;/);
    expect(css).not.toMatch(/@media \(max-width: 768px\)[\s\S]*?\.planning-plan-actions \.btn\.planning-add-comment--mobile\s*\{[^}]*position\s*:\s*fixed\s*;/);
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.planning-comment-editor\s*\{[^}]*position\s*:\s*fixed\s*;/);
  });
});
