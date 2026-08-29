// @vitest-environment node

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../../../");

function readDashboardGuide(): string {
  return readFileSync(path.join(repoRoot, "docs/dashboard-guide.md"), "utf8");
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
});
