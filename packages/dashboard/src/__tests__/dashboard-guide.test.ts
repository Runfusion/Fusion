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

  it("documents the responsive Alpha Header and Quick Entry hold contract", () => {
    const guide = readDashboardGuide();

    expect(guide).toContain("New Task** is absent from both the Alpha desktop footer and Header");
    expect(guide).toContain("tablet and mobile retain the rightmost compact Header action");
    expect(guide).toContain("one non-wrapping row; long workflow names truncate before the Search icon moves");
    expect(guide).toContain("icon-only Save button");
    expect(guide).toContain("hold continuously for 1,200 ms");
    expect(guide).toContain("Non-Alpha Quick Entry retains its text Save button and separate Start action");
  });

  it("documents the ascending single-column Alpha desktop More menu", () => {
    const guide = readDashboardGuide();

    expect(guide).toContain("More** opens above its trigger as a compact single vertical column");
    expect(guide).toContain("one destination per row and vertical scrolling when the list grows beyond the viewport");
    expect(guide).toContain("leaving the combined trigger-menu region closes it");
  });

  it("documents bottom-entering mobile drawers and Task Detail close ownership", () => {
    const guide = readDashboardGuide();

    expect(guide).toContain("every mobile drawer rises vertically from below with no lateral movement");
    expect(guide).toContain("when reduced motion is requested, it appears without that transition");
    expect(guide).toContain("The drawer omits the redundant **Back to board** action");
    expect(guide).toContain("Desktop Board panels retain **Back to board**");
  });

  it("documents canonical Task Detail tabs with mouse drag-to-scroll and native touch", () => {
    const guide = readDashboardGuide();

    expect(guide).toContain("drag it horizontally with the left mouse button to scroll without using the wheel");
    expect(guide).toContain("a stationary click still selects its tab or opens the Activity menu");
    expect(guide).toContain("Tab order always remains canonical");
    expect(guide).toContain("Touch and pen input keep the browser's native horizontal pan and tap behavior");
    expect(guide).not.toContain("drag a tab with the mouse to reorder it");
    expect(guide).not.toContain("Alt+ArrowLeft");
  });

  it("documents permanent Planning sessions off phone and compact phone navigation", () => {
    const guide = readDashboardGuide();
    const planningBody = getSectionBody(guide, "Planning Mode");

    expect(planningBody).toContain("saved-session sidebar remains visible and resizable");
    expect(planningBody).toContain("Phone layouts continue to use compact list/detail navigation");
    expect(planningBody).toContain("Back** returns to it");
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
