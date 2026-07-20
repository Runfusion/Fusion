import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("PlanningModeModal sequential layout", () => {
  it("removes retired three-pane and compact interview selectors across responsive surfaces", () => {
    const css = readFileSync(resolve(process.cwd(), "app/components/PlanningModeModal.css"), "utf8");
    expect(css).not.toMatch(/planning-compact-pane-switcher|planning-running-plan|planning-answered-history/);
    expect(css).toContain("planning-summary-actions");
  });
});
