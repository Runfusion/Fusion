import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Theme-safety regression tests for ActivityFeed CSS and component.
 *
 * These tests verify that ActivityFeed styles use theme-aware tokens
 * instead of hardcoded colors, ensuring correct rendering across all
 * color themes and light/dark modes.
 */
describe("ActivityFeed theme styling", () => {
  let activityFeedCss: string;

  beforeAll(() => {
    activityFeedCss = fs.readFileSync(
      path.resolve(__dirname, "../components/ActivityFeed.css"),
      "utf-8",
    );
  });

  function getActivityFeedBlock(): string {
    return activityFeedCss;
  }

  it("does not use hardcoded rgba(88, 166, 255) in the project badge background", () => {
    const block = getActivityFeedBlock();

    // The old hardcoded blue: rgba(88, 166, 255, 0.1)
    expect(block).not.toContain("rgba(88, 166, 255");

    // The project badge should use theme-aware color-mix instead
    expect(block).toContain("color-mix(in srgb, var(--todo) 10%, transparent)");
  });

  it("uses --color-error token (not undefined --error) for error message styling", () => {
    const block = getActivityFeedBlock();

    // --error is not a defined token; --color-error is correct
    expect(block).not.toContain("var(--error)");
    expect(block).toContain("var(--color-error)");
  });

  it("uses design tokens for all color references in activity-feed rules", () => {
    const block = getActivityFeedBlock();

    // Token-based colors should be used (var(--...))
    // No raw hex colors (#xxx) in activity feed rules except through tokens
    const lines = block.split("\n");
    const colorLines = lines.filter(
      (line) =>
        line.includes("color:") ||
        line.includes("background:") ||
        line.includes("border-color:")
    );

    // Every color/background/border-color line should use var() or color-mix()
    for (const line of colorLines) {
      // Skip lines that are just property declarations without values
      const value = line.split(":").slice(1).join(":").trim().replace(/;$/, "");

      // Allow transparent, none, inherit, initial
      if (["transparent", "none", "inherit", "initial", ""].includes(value)) {
        continue;
      }

      // Every value should use var() or color-mix() — no hardcoded hex/rgb/rgba
      expect(
        value.includes("var(") || value.includes("color-mix("),
        `Expected token-based color but got hardcoded: "${line.trim()}"`
      ).toBe(true);
    }
  });
});

describe("ActivityFeed component theme tokens", () => {
  const componentPath = path.resolve(
    __dirname,
    "../components/ActivityFeed.tsx"
  );
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(componentPath, "utf-8");
  });

  it("does not reference undefined --error token in TYPE_CONFIG", () => {
    // --error is not a defined CSS custom property; the correct token is --color-error
    // Search for var(--error) but NOT var(--color-error)
    const varErrorPattern = /var\(--error\)(?!-)/g;
    const matches = source.match(varErrorPattern);
    expect(
      matches,
      `Found var(--error) in ActivityFeed.tsx — use var(--color-error) instead`
    ).toBeNull();
  });

  it("uses valid theme tokens for all event type colors", () => {
    // Extract color values from TYPE_CONFIG
    const typeConfigMatch = source.match(
      /TYPE_CONFIG[^=]*=\s*\{([\s\S]*?)\};/
    );
    expect(typeConfigMatch).not.toBeNull();

    const configBlock = typeConfigMatch![1];
    const colorValues = [...configBlock.matchAll(/color:\s*"([^"]+)"/g)].map(
      (m) => m[1]
    );

    // Every color should be a var() token reference
    for (const color of colorValues) {
      expect(
        color.startsWith("var(--"),
        `Expected token reference but got: "${color}"`
      ).toBe(true);
    }
  });

  it("does not contain hardcoded hex colors in inline styles", () => {
    // No raw #rrggbb or #rgb hex values in the component source
    const hexPattern = /"[^"]*#[0-9a-fA-F]{3,8}[^"]*"/g;
    const matches = source.match(hexPattern);
    expect(
      matches,
      `Found hardcoded hex colors in ActivityFeed.tsx: ${matches}`
    ).toBeNull();
  });
});
