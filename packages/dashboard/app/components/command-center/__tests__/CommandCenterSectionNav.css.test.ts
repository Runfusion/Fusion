import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const componentDir = join(__dirname, "..");

describe("Command Center section navigation CSS", () => {
  it("removes tab-strip styles while retaining the panel scroll owner and bounding the menu", () => {
    const commandCenterCss = readFileSync(join(componentDir, "CommandCenter.css"), "utf8");
    const sectionNavCss = readFileSync(join(componentDir, "CommandCenterSectionNav.css"), "utf8");
    expect(commandCenterCss).not.toMatch(/\.cc-tab(?:list|[\s.{:#])/);
    expect(commandCenterCss).toContain(".cc-tabpanel");
    expect(commandCenterCss).toContain("overflow-y: auto");
    expect(commandCenterCss).toContain("@media (max-width: 768px)");
    expect(commandCenterCss).toContain("flex-wrap: wrap");
    expect(sectionNavCss).toContain("max-block-size");
    expect(sectionNavCss).toContain("overflow-y: auto");
  });

  /*
  FNXC:CommandCenterSectionNav 2026-09-17-11:22:
  FN-508 : la bande de rubriques téléphone est posée dans la zone `tabs` partagée, dont le `overflow-x: auto`
  rognerait le menu absolu de la drop list. Le rognage doit être levé par un sélecteur scoped au Command Center, la
  présentation pleine largeur doit occuper toute la largeur et neutraliser la borne téléphone du menu compact.
  */
  it("scopes the full-width section strip so the dropdown menu is not clipped by the shared tabs zone", () => {
    const commandCenterCss = readFileSync(join(componentDir, "CommandCenter.css"), "utf8");
    const sectionNavCss = readFileSync(join(componentDir, "CommandCenterSectionNav.css"), "utf8");

    expect(commandCenterCss).toMatch(/\.command-center\s*>\s*\.view-layout__tabs\s*\{[^}]*overflow:\s*visible/);
    expect(commandCenterCss).toMatch(/\.cc-section-strip\s*\{[^}]*inline-size:\s*100%/);

    expect(sectionNavCss).toMatch(/\.cc-section-nav--full\s*\{[^}]*inline-size:\s*100%/);
    expect(sectionNavCss).toMatch(/\.cc-section-nav--full\s+\.cc-section-nav-trigger\s*\{[^}]*inline-size:\s*100%/);
    expect(sectionNavCss).toMatch(/\.cc-section-nav--full\s+\.cc-section-nav-menu\s*\{[^}]*inset-inline:\s*0/);
    expect(sectionNavCss).toMatch(/\.cc-section-nav--full\s+\.cc-section-nav-menu\s*\{[^}]*max-inline-size:\s*none/);
  });
});
