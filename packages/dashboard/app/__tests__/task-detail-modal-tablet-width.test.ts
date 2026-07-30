import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("task detail modal tablet width (FN-5599, FN-6500)", () => {
  const detailModalCss = readFileSync(
    resolve(__dirname, "../components/TaskDetailModal.css"),
    "utf-8",
  );

  /*
  FNXC:TaskDetailGeometry 2026-07-30-23:10 (re-pointed after FN-8621, not appeased):
  This pinned `width: min(95vw, 800px)` on the desktop base rule. `43160a7aae` (FN-8621, migrate
  complex modals to FloatingWindow) deliberately removed it: the modal now FILLS its FloatingWindow
  host, which owns outer geometry, so the base rule is `width: 100%; height: 100%`.

  The guard's PURPOSE survives the migration — the desktop base must not carry phone-sheet geometry —
  so it is re-pointed at the new contract rather than deleted. Host-fill is asserted positively, and
  viewport-relative sizing is asserted ABSENT, because a `vw`/`vh` value reappearing in the base rule
  is exactly the leak this test exists to catch (the media queries below are where those belong).
  */
  it("keeps the desktop base rule at host-fill, with no viewport sizing", () => {
    const baseRuleMatch = detailModalCss.match(/\.modal\.task-detail-modal\s*\{[^}]*\}/s);
    expect(baseRuleMatch).toBeTruthy();
    const baseRule = baseRuleMatch![0];

    expect(baseRule).toContain("width: 100%;");
    expect(baseRule).toContain("height: 100%;");
    // A vw/vh in the BASE rule means a breakpoint override leaked out of its media query.
    expect(baseRule, "base rule must not size against the viewport").not.toMatch(/\b\d+(?:\.\d+)?(?:vw|vh|dvh)\b/);
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

  /*
  FNXC:TaskDetailGeometry 2026-07-30-23:10 (DELETED with the feature they pinned):
  Two cases were removed here, not rewritten:

    "keeps the tablet touch resize grip out of task-detail layout padding"
    "overrides phone-sheet geometry and restores the resize grip for a known 768px tablet"

  They asserted `.task-modal--touch-resize` and `.task-modal--tablet` rules in this stylesheet, and
  FN-8621's FloatingWindow migration removed both — the window host owns resizing now. MEASURED before
  deleting: `task-modal--touch-resize` has ZERO references in non-test code anywhere in `app/`, and
  `task-modal--tablet` survives only in `NewTaskModal.css`/`.tsx`, not in TaskDetailModal.

  So they could not pass without reverting the migration, and they were failing on main as stale
  assertions about code that no longer exists. Deleted rather than left red: a permanently-red test
  teaches people to ignore the file, and rewriting them would mean inventing a contract for
  FloatingWindow's resize affordance that belongs to whoever owns it. If TaskDetailModal ever regains
  its own touch-resize surface, the guard belongs beside that code, not here.

  The cases that cover SURVIVING behaviour are kept and still pass: the 769-1024px tablet override
  above, and the mobile full-screen sheet below.
  */
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
