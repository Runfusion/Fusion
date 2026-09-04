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
});
