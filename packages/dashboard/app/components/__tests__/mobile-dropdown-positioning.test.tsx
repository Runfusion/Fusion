import fs from "node:fs";
import { loadAllAppCss } from "../../test/cssFixture";
import path from "node:path";
import { describe, expect, it } from "vitest";


describe("mobile dropdown positioning and momentum scrolling css", () => {
  it("includes iOS momentum scrolling for dep-dropdown", () => {
    const css = loadAllAppCss();

    expect(css).toMatch(/\.dep-dropdown[\s\S]*-webkit-overflow-scrolling:\s*touch;/);
  });

  it("includes iOS momentum scrolling for file-browser-list", () => {
    const css = loadAllAppCss();

    expect(css).toMatch(/\.file-browser-list[\s\S]*-webkit-overflow-scrolling:\s*touch;/);
  });

  it("includes modal momentum scrolling selectors inside the 768px mobile media query", () => {
    const css = loadAllAppCss();
    const momentumBlockMatch = css.match(/@media \(max-width: 768px\)\s*\{[\s\S]*\/\* iOS momentum scrolling for all modal content areas \*\/[\s\S]*?\}/);

    expect(momentumBlockMatch).toBeTruthy();

    const block = momentumBlockMatch?.[0] ?? "";
    expect(block).toContain(".modal-content");
    expect(block).toContain(".modal-body");
    expect(block).toContain(".modal-scroll");
    expect(block).toContain(".task-detail-content");
    expect(block).toContain(".agent-log-content");
    expect(block).toContain(".file-browser-list");
    expect(block).toContain(".settings-content");
    expect(block).toContain(".activity-log-content");
    expect(block).toContain("-webkit-overflow-scrolling: touch;");
  });
});
