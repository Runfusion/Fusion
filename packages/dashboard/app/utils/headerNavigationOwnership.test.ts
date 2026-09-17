import { describe, expect, it } from "vitest";
import { resolveHeaderNavigationOwnership } from "./headerNavigationOwnership";

/*
FNXC:HeaderNavigationOwnership 2026-09-17-02:14:
FN-481 : le résolveur décide ce que le Header offre DÉJÀ. Toute destination absente d'ici doit rester atteignable en
bas, donc les cas « capacité absente » comptent autant que les cas « capacité présente ».
*/
describe("resolveHeaderNavigationOwnership", () => {
  const phone = { mode: "mobile" as const, mobileNavEnabled: true };
  const tablet = { mode: "tablet" as const, mobileNavEnabled: true };
  const desktop = { mode: "desktop" as const, mobileNavEnabled: false };

  it("ne possède rien quand aucune capacité n'est fournie", () => {
    expect(resolveHeaderNavigationOwnership({ mode: "mobile" })).toEqual([]);
    expect(resolveHeaderNavigationOwnership({ mode: "tablet" })).toEqual([]);
    expect(resolveHeaderNavigationOwnership({ mode: "desktop" })).toEqual([]);
  });

  it("possède Usage et Projets sur téléphone avec pill, mais jamais Notes ni Activity", () => {
    const owned = resolveHeaderNavigationOwnership({
      ...phone,
      hasOpenUsage: true,
      hasOpenNotesPanel: true,
      hasOpenActivityPanel: true,
      projectCount: 1,
      hasSelectProject: true,
      hasViewAllProjects: true,
    });
    expect(owned).toContain("usage");
    expect(owned).toContain("projects");
    expect(owned).not.toContain("notes");
    expect(owned).not.toContain("activity");
  });

  it("ne possède pas Usage sur le Header téléphone historique sans pill", () => {
    const owned = resolveHeaderNavigationOwnership({
      mode: "mobile",
      mobileNavEnabled: false,
      hasOpenUsage: true,
      projectCount: 2,
      hasSelectProject: true,
      hasViewAllProjects: true,
    });
    expect(owned).not.toContain("usage");
    expect(owned).toContain("projects");
  });

  it.each([
    ["tablette", tablet],
    ["ordinateur", desktop],
  ])("possède les quatre destinations sur %s", (_label, viewport) => {
    const owned = resolveHeaderNavigationOwnership({
      ...viewport,
      hasOpenUsage: true,
      hasOpenNotesPanel: true,
      hasOpenActivityPanel: true,
      projectCount: 3,
      hasViewAllProjects: true,
    });
    expect(owned.sort()).toEqual(["activity", "notes", "projects", "usage"]);
  });

  it("ne possède pas Notes ni Activity sans leur callback de panneau", () => {
    const owned = resolveHeaderNavigationOwnership({
      ...tablet,
      hasOpenUsage: true,
      hasOpenNotesPanel: false,
      hasOpenActivityPanel: false,
      projectCount: 1,
      hasViewAllProjects: true,
    });
    expect(owned).toEqual(["usage", "projects"]);
  });

  it.each([
    ["aucun projet", 0],
    ["liste vide", 0],
  ])("ne possède pas Projets sans projet proposé (%s)", (_label, projectCount) => {
    const owned = resolveHeaderNavigationOwnership({
      ...tablet,
      projectCount,
      hasSelectProject: true,
      hasViewAllProjects: true,
    });
    expect(owned).not.toContain("projects");
  });

  it("ne possède pas Projets sans action de gestion, quel que soit le mode", () => {
    for (const viewport of [phone, tablet, desktop]) {
      const owned = resolveHeaderNavigationOwnership({
        ...viewport,
        projectCount: 4,
        hasSelectProject: true,
        hasViewAllProjects: false,
      });
      expect(owned).not.toContain("projects");
    }
  });

  it("exige `onSelectProject` sur téléphone mais pas hors téléphone", () => {
    const phoneOwned = resolveHeaderNavigationOwnership({
      ...phone,
      projectCount: 2,
      hasSelectProject: false,
      hasViewAllProjects: true,
    });
    expect(phoneOwned).not.toContain("projects");

    const tabletOwned = resolveHeaderNavigationOwnership({
      ...tablet,
      projectCount: 2,
      hasSelectProject: false,
      hasViewAllProjects: true,
    });
    expect(tabletOwned).toContain("projects");
  });

  it("possède Projets dès un seul projet", () => {
    expect(
      resolveHeaderNavigationOwnership({ ...phone, projectCount: 1, hasSelectProject: true, hasViewAllProjects: true }),
    ).toContain("projects");
  });

  it("traite un nombre de projets non fini comme aucun projet", () => {
    expect(
      resolveHeaderNavigationOwnership({
        ...tablet,
        projectCount: Number.NaN,
        hasViewAllProjects: true,
      }),
    ).not.toContain("projects");
  });
});
