import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly, loadThemeDataCss } from "../test/cssFixture";

const ALLOWED_EXCEPTIONS: string[] = [];

function stripVarFallbackRgba(content: string): string {
  return content.replace(/var\([^()]*,\s*rgba?\([^)]*\)\s*\)/g, "");
}

function findRawRgbViolations(source: string, fileName: string): string[] {
  const withoutFallbacks = stripVarFallbackRgba(source);
  const lines = withoutFallbacks.split(/\r?\n/);

  return lines
    .flatMap((line, index) =>
      /rgba?\(/.test(line) ? [`${fileName}:${index + 1}:${line.trim()}`] : []
    )
    .filter((violation) => !ALLOWED_EXCEPTIONS.includes(violation));
}

function buildRawRgbFailureMessage(violations: string[]): string {
  return [
    "Raw rgb/rgba() found in global dashboard CSS.",
    "Use design tokens or color-mix(in srgb, var(--color-X) N%, transparent) instead.",
    "Allowed exceptions must be documented in ALLOWED_EXCEPTIONS:",
    ...violations,
  ].join("\n");
}

describe("global and theme CSS color token hygiene", () => {
  it("detects raw rgb/rgba calls but permits var() fallback rgb/rgba", () => {
    const source = [
      ".clean { color: var(--color-text); }",
      ".fallback { color: var(--custom-color, rgba(1, 2, 3, 0.5)); }",
      ".violation { box-shadow: 0 0 0 1px rgba(1, 2, 3, 0.5); }",
    ].join("\n");

    const violations = findRawRgbViolations(source, "fixture.css");

    expect(violations).toEqual([
      "fixture.css:3:.violation { box-shadow: 0 0 0 1px rgba(1, 2, 3, 0.5); }",
    ]);
    expect(buildRawRgbFailureMessage(violations)).toContain(
      "fixture.css:3:.violation { box-shadow: 0 0 0 1px rgba(1, 2, 3, 0.5); }"
    );
    expect(buildRawRgbFailureMessage(violations)).toContain(
      "color-mix(in srgb, var(--color-X) N%, transparent)"
    );
  });

  it("keeps base global CSS free of raw rgb/rgba calls outside var() fallbacks", () => {
    const violations = findRawRgbViolations(loadAllAppCssBaseOnly(), "loadAllAppCssBaseOnly()");

    expect(violations, buildRawRgbFailureMessage(violations)).toEqual([]);
  });

  it("keeps all app CSS free of raw rgb/rgba calls outside var() fallbacks", () => {
    const violations = findRawRgbViolations(loadAllAppCss(), "loadAllAppCss()");

    expect(violations, buildRawRgbFailureMessage(violations)).toEqual([]);
  });

  it("keeps theme-data CSS free of raw rgb/rgba calls outside var() fallbacks", () => {
    const violations = findRawRgbViolations(loadThemeDataCss(), "public/theme-data.css");

    expect(violations, buildRawRgbFailureMessage(violations)).toEqual([]);
  });
});
