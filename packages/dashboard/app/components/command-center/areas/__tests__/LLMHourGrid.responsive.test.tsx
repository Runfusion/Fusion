import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/*
FNXC:LaneTelemetry 2026-11-04-07:25 (R6):
The Tokens area's LLM-telemetry plate has to read on a phone as well as on a desktop, and jsdom cannot
evaluate a @media query — so the responsive contract is pinned against the stylesheet itself, the same way
detail-body-mobile-overflow.test.ts pins the task detail's. What is asserted is behavior an operator
depends on: the grid reflows by scrolling rather than squashing, a spend tile stays a >=36px press target,
the prompt-head list is capped and scrolls instead of pushing the rest of the area away, and the sheet
stays tokenized (no hex, no rgba) so a theme switch repaints it.
*/

const css = readFileSync(resolve(__dirname, "../LLMHourGrid.css"), "utf-8");

function rule(selector: string): string {
  const match = css.match(new RegExp(`\\.${selector}\\s*\\{[^}]*\\}`));
  expect(match, `missing .${selector} rule`).toBeTruthy();
  return match![0];
}

function mediaBlock(query: string): string {
  const match = css.match(new RegExp(`@media[^{]*\\(${query}\\)[^{]*\\{([\\s\\S]*?)\\n\\}`));
  expect(match, `missing @media (${query}) block`).toBeTruthy();
  return match![1];
}

describe("LLMHourGrid responsive and design-token contract", () => {
  it("reflows the grid by scrolling sideways instead of squashing the lane column", () => {
    expect(rule("cc-llm-scroll")).toContain("overflow-x: auto");
    // A lane row that scrolls out of its own label is unreadable, so the identity column stays pinned.
    const laneCol = rule("cc-llm-lane-col");
    expect(laneCol).toContain("position: sticky");
    expect(laneCol).toContain("min-inline-size");
  });

  it("keeps every press target at least the minimum touch size", () => {
    expect(rule("cc-llm-tile")).toMatch(/min-block-size:\s*2\.25rem/);
    expect(rule("cc-llm-head-toggle")).toMatch(/min-block-size:\s*2\.25rem/);
  });

  it("caps the prompt-head list and lets it scroll", () => {
    const list = rule("cc-llm-head-list");
    expect(list).toMatch(/max-block-size:/);
    expect(list).toContain("overflow-y: auto");
  });

  it("keeps the capped head list inside the mobile breakpoint", () => {
    const mobile = mediaBlock("max-width:\\s*768px");
    expect(mobile).toContain("cc-llm-head-list");
    expect(mobile).toMatch(/max-block-size:/);
    expect(mobile).toContain("cc-llm-heads");
  });

  it("paints with design tokens only, never with a literal colour", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
    expect(css).toContain("color-mix(");
    expect(css).toContain("var(--space-");
    expect(css).toContain("var(--radius-");
    expect(css).toContain("var(--duration-");
  });

  it("honours a reduced-motion preference", () => {
    expect(mediaBlock("prefers-reduced-motion:\\s*reduce")).toContain("transition: none");
  });
});
