// @vitest-environment node

import { describe, it, expect } from "vitest";
import { readAppFile } from "../../app/test/cssFixture";

function readDashboardGuide(): string {
  return readAppFile("../../../docs/dashboard-guide.md");
}

function getSectionBody(doc: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = doc.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match?.[1]?.trim() ?? "";
}

describe("dashboard guide coverage for lazy-loaded views", () => {
  const requiredSections = [
    "Dev Server View",
    "Agents View",
    "Roadmaps View",
    "Insights View",
    "Reports View",
    "Plugin Manager",
    "Pi Extensions Manager",
  ] as const;

  it("includes all required section headings", () => {
    const guide = readDashboardGuide();

    for (const section of requiredSections) {
      expect(guide).toContain(`## ${section}`);
    }
  });

  it("documents non-empty section bodies with guide-style structure markers", () => {
    const guide = readDashboardGuide();

    for (const section of requiredSections) {
      const body = getSectionBody(guide, section);
      expect(body.length).toBeGreaterThan(0);
      expect(body).toMatch(/(?:^|\n)(?:- |> |\|\s|!\[)/m);
    }
  });

  it("includes key navigation/settings terms for plugin surfaces", () => {
    const guide = readDashboardGuide();
    const pluginBody = getSectionBody(guide, "Plugin Manager");
    const piBody = getSectionBody(guide, "Pi Extensions Manager");

    expect(pluginBody).toContain("Settings → Plugins → Fusion Plugins");
    expect(piBody).toContain("Settings → Plugins → Pi Extensions");
  });

  it("documents the selectable Liquid Glass web contract without claiming native parity", () => {
    const guide = readDashboardGuide();

    expect(guide).toContain("94 color themes");
    expect(guide).toContain("Liquid Glass is an independent preset");
    expect(guide).toContain("Board columns and cards deliberately remain more opaque");
    expect(guide).toContain("reduced-motion, reduced-transparency, increased-contrast, and forced-color");
    expect(guide).toContain("Apple’s publicly documented material principles for web-applicable interfaces");
  });
});
