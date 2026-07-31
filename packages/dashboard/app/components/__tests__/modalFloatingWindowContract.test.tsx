import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";
import { migratedModalFixtures } from "./migratedModalFixtures";

/* FNXC:ModalTouchGeometry 2026-07-26-18:49: Keep the inventory decision in one executable table: a non-trivial static dialog needs a reason, while every hosted dialog must keep both sheet safeguards. */
describe("FN-8607 migrated modal FloatingWindow contract", () => {
  it.each(migratedModalFixtures.filter((fixture) => !fixture.optOut))("hosts $name with persistent, blocking tablet geometry", (fixture) => {
    const source = readAppFile(`components/${fixture.file}`);
    expect(source).toContain("<FloatingWindow");
    expect(source).toContain(`persistGeometryKey=\"${fixture.key}\"`);
    expect(source).toContain("suspendGeometryPersistenceOnMobile");
    expect(source).toContain("suspendGeometryPersistenceOnShortViewport");
    expect(source).toContain("dragHandleSelector");
    expect(source).toContain(" modal");
    expect(source.includes("closeOnOutsidePointerDown")).toBe(fixture.outside);
  });

  it.each(migratedModalFixtures.filter((fixture) => fixture.optOut))("keeps $name as justified inventory opt-out", (fixture) => {
    const source = readAppFile(`components/${fixture.file}`);
    expect(source).not.toContain("<FloatingWindow");
    expect(fixture.optOut).toMatch(/.+/);
  });

  it("records every hosted production modal in the fixture table", () => {
    expect(migratedModalFixtures.filter((fixture) => fixture.key)).toHaveLength(11);
  });

  it("makes every FN-8607 host a full-screen sheet on phone and short viewports", () => {
    const css = readAppFile("components/FloatingWindow.css");
    const sheetBlock = css.match(/@media \(max-width: 767\.98px\), \(max-height: 480px\) \{[\s\S]*?\.floating-window--image-preview \{/);
    expect(sheetBlock?.[0]).toContain("width: 100vw !important;");
    expect(sheetBlock?.[0]).toContain("height: 100dvh !important;");
    for (const fixture of migratedModalFixtures.filter((candidate) => candidate.key)) {
      const className = fixture.key!.replace("floating-window:", "floating-window--");
      expect(sheetBlock?.[0]).toContain(className);
      expect(css).toContain(`${className} .floating-window__resize-handle`);
    }
  });

});
