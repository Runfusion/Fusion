import fs from "node:fs";
import { loadAllAppCss } from "../../test/cssFixture";
import path from "node:path";
import { describe, expect, it } from "vitest";


function getMissionMobileSection(css: string): string {
  const start = css.indexOf("/* ================================================================\n   Responsive — Mission Manager on mobile (≤768px)");
  expect(start).toBeGreaterThan(-1);

  // After CSS extraction, the Workflow Results block lives in
  // WorkflowResultsTab.css; the mission mobile section now ends just before
  // the appended light-theme overrides at the end of MissionManager.css.
  const end = css.indexOf("/* Light theme overrides", start);
  expect(end).toBeGreaterThan(start);

  return css.slice(start, end);
}

describe("MissionManager mobile styles", () => {
  it("adds responsive tab and activity layout rules", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);

    expect(section).toContain(".mission-detail__tabs {");
    expect(section).toContain("overflow-x: auto;");
    expect(section).toContain(".mission-detail__activity-controls {");
    expect(section).toContain("flex-direction: column;");
    expect(section).toContain(".mission-detail__activity-filter,");
    expect(section).toContain(".mission-detail__activity-filter select {");
    expect(section).toContain("width: 100%;");
  });

  it("adds mobile overflow protection for activity event content", () => {
    const css = loadAllAppCss();
    const section = getMissionMobileSection(css);

    expect(section).toContain(".mission-events {");
    expect(section).toContain("max-height: min(46vh, 360px);");
    expect(section).toContain(".mission-event__description,");
    expect(section).toContain("overflow-wrap: anywhere;");
    expect(section).toContain("word-break: break-word;");
  });
});
