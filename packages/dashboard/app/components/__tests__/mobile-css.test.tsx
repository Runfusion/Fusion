import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const stylesPath = path.resolve(__dirname, "../../styles.css");
const indexHtmlPath = path.resolve(__dirname, "../../index.html");

function getMainMobileSection(css: string): string {
  const sectionStart = css.indexOf("/* === Mobile Responsive Overrides ===");
  const sectionEnd = css.indexOf("/* === Tablet Responsive Tier", sectionStart);

  expect(sectionStart).toBeGreaterThan(-1);
  expect(sectionEnd).toBeGreaterThan(sectionStart);

  return css.slice(sectionStart, sectionEnd);
}

function getFirstRootBlock(css: string): string {
  const match = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  expect(match).toBeTruthy();
  return match![1];
}

describe("mobile CSS foundation", () => {
  it("defines canonical mobile breakpoint custom properties in the first :root block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const firstRoot = getFirstRootBlock(css);

    expect(firstRoot).toContain("--mobile-breakpoint: 768px;");
    expect(firstRoot).toContain("--tablet-breakpoint: 1024px;");
    expect(firstRoot).toContain("--small-breakpoint: 480px;");
    expect(firstRoot).toContain("--xsmall-breakpoint: 640px;");
  });

  it("provides a touch-target utility class with 44px minimum dimensions", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const touchTargetMatch = css.match(/\.touch-target\s*\{([\s\S]*?)\}/);

    expect(touchTargetMatch).toBeTruthy();
    expect(touchTargetMatch![1]).toContain("min-width: 44px;");
    expect(touchTargetMatch![1]).toContain("min-height: 44px;");
  });

  it("enforces 16px font size for text inputs in the main mobile media query", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expect(mobileSection).toContain("@media (max-width: 768px)");
    expect(mobileSection).toContain('input[type="text"]');
    expect(mobileSection).toContain('input[type="search"]');
    expect(mobileSection).toContain('input[type="tel"]');
    expect(mobileSection).toContain("select,");
    expect(mobileSection).toContain("textarea {");
    expect(mobileSection).toContain("font-size: 16px;");
  });

  it("applies safe-area inset handling in the main mobile section", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expect(mobileSection).toContain("#root {");
    expect(mobileSection).toContain("padding-top: env(safe-area-inset-top, 0px);");
    expect(mobileSection).toContain("padding-bottom: env(safe-area-inset-bottom, 0px);");
    expect(mobileSection).toContain(".header {");
    expect(mobileSection).toContain("padding-left: max(var(--space-md), env(safe-area-inset-left, 0px));");
    expect(mobileSection).toContain(".board {");
    expect(mobileSection).toContain("padding-bottom: max(var(--space-md), env(safe-area-inset-bottom, 0px));");
    expect(mobileSection).toContain(".modal,");
    expect(mobileSection).toContain("padding-bottom: env(safe-area-inset-bottom, 0px);");
  });

  it("adds mobile overflow guards for wide content", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expect(mobileSection).toContain("* {");
    expect(mobileSection).toContain("max-width: 100vw;");
    expect(mobileSection).toContain("pre,");
    expect(mobileSection).toContain("overflow-x: auto;");
    expect(mobileSection).toContain(".code-block");
    expect(mobileSection).toContain("word-break: break-all;");
    expect(mobileSection).toContain("word-break: break-word;");
    expect(mobileSection).toContain("img,");
    expect(mobileSection).toContain("svg {");
    expect(mobileSection).toContain("max-width: 100%;");
    expect(mobileSection).toContain("table {");
    expect(mobileSection).toContain("display: block;");
    expect(mobileSection).toContain("-webkit-overflow-scrolling: touch;");
    expect(mobileSection).toContain(".workflow-step-manager-modal {");
    expect(mobileSection).toContain("max-height: 100dvh;");
  });

  it("keeps the capacitor viewport meta tag configured", () => {
    const html = fs.readFileSync(indexHtmlPath, "utf-8");

    expect(html).toContain("name=\"viewport\"");
    expect(html).toContain("width=device-width");
    expect(html).toContain("maximum-scale=1.0");
    expect(html).toContain("user-scalable=no");
  });

  it("uses only approved max-width breakpoint values", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const matches = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)];
    const foundValues = new Set(matches.map((match) => Number(match[1])));
    const allowedValues = new Set([480, 640, 768, 860]);

    expect(foundValues.size).toBeGreaterThan(0);
    for (const value of foundValues) {
      expect(allowedValues.has(value)).toBe(true);
    }
  });
});
