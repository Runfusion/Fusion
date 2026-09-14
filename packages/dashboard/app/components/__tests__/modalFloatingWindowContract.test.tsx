import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";
import { migratedModalFixtures } from "./migratedModalFixtures";

/* FNXC:ModalTouchGeometry 2026-07-26-18:49: Keep the inventory decision in one executable table: every hosted dialog must keep both sheet safeguards. */
/* FNXC:FloatingWindowDialogHosts 2026-09-14-22:36: FN-394 removed the desktop static opt-out, so the inventory is now hosts only; a dialog owned by a larger view declares that view instead of a standalone render. */
/* FNXC:FloatingWindowGeometry 2026-09-14-21:10: FN-394 deleted durable window geometry, so no host may declare a geometry key any more; the sheet safeguards and delegated drag handle remain required. */
describe("FN-8607 migrated modal FloatingWindow contract", () => {
  it.each(migratedModalFixtures.filter((fixture) => !fixture.optOut))("hosts $name with blocking tablet geometry and no durable geometry key", (fixture) => {
    const source = readAppFile(`components/${fixture.file}`);
    expect(source).toContain("<FloatingWindow");
    expect(source).not.toContain("persistGeometryKey");
    expect(source).toContain("suspendGeometryPersistenceOnMobile");
    expect(source).toContain("suspendGeometryPersistenceOnShortViewport");
    expect(source).toContain("dragHandleSelector");
    expect(source).toContain(" modal");
    expect(source.includes("closeOnOutsidePointerDown")).toBe(fixture.outside);
  });

  it("keeps no static desktop opt-out in the inventory", () => {
    expect(migratedModalFixtures.filter((fixture) => fixture.optOut)).toHaveLength(0);
  });

  /* FNXC:ModalTouchGeometry 2026-08-23-21:10: FN-074 removed task splitting, retiring the Subtask Breakdown host from this inventory (11 -> 10). */
  /* FNXC:FloatingWindowDialogHosts 2026-09-14-22:36: FN-394 re-hosted the remaining dashboard dialogs, so every inventory row is a host. */
  it("records every hosted production modal in the fixture table", () => {
    expect(migratedModalFixtures.filter((fixture) => fixture.key)).toHaveLength(migratedModalFixtures.length);
    expect(migratedModalFixtures.length).toBe(31);
  });

  it("gives every inventory row either a production render or the view that owns it", () => {
    for (const fixture of migratedModalFixtures) {
      expect(Boolean(fixture.render) || Boolean(fixture.hostedInsideView), `${fixture.name} needs a render or an owning view`).toBe(true);
    }
  });

  it("makes every FN-8607 host a full-screen sheet on phone and short viewports", () => {
    const css = readAppFile("components/FloatingWindow.css");
    const sheetBlock = css.match(/@media \(max-width: 767\.98px\), \(max-height: 480px\) \{[\s\S]*?\.floating-window--image-preview \{/);
    expect(sheetBlock?.[0]).toContain("width: 100vw !important;");
    expect(sheetBlock?.[0]).toContain("height: 100dvh !important;");
    for (const fixture of migratedModalFixtures.filter((candidate) => candidate.key)) {
      const className = fixture.sheetClass ?? fixture.key!.replace("floating-window:", "floating-window--");
      expect(sheetBlock?.[0]).toContain(className);
      expect(css).toContain(`${className} .floating-window__resize-handle`);
    }
  });

});
