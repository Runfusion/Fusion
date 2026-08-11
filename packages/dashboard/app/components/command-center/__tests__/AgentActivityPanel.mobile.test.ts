import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "AgentActivityPanel.css"), "utf8");

describe("AgentActivityPanel mobile styles", () => {
  it("uses a mobile layout and only tokenized colors", () => {
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.cc-agent-activity-filters/);
    expect(css).toMatch(/@media \(max-height: 480px\) and \(max-width: 768px\)/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toContain("rgba(");
    expect(css.replaceAll("768px", "").replaceAll("480px", "")).not.toMatch(/\b(?:[1-9]\d*)px\b/);
  });
});
