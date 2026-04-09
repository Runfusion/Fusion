import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = readFileSync(resolve(__dirname, "../styles.css"), "utf-8");

describe("detail-body mobile overflow (FN-1331)", () => {
  it("adds overflow-x: hidden to .detail-body in the main mobile media query", () => {
    // Find the main mobile responsive overrides section
    const sectionStart = css.indexOf("/* === Mobile Responsive Overrides ===");
    const sectionEnd = css.indexOf("/* === Tablet Responsive Tier", sectionStart);
    expect(sectionStart).toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);

    const mobileSection = css.slice(sectionStart, sectionEnd);

    // Extract .detail-body block within the mobile section
    const detailBodyMatch = mobileSection.match(/\.detail-body\s*\{[^}]*\}/s);
    expect(detailBodyMatch).toBeTruthy();
    expect(detailBodyMatch![0]).toContain("overflow-x: hidden");
  });

  it("preserves the padding: 14px in the mobile .detail-body rule", () => {
    const sectionStart = css.indexOf("/* === Mobile Responsive Overrides ===");
    const sectionEnd = css.indexOf("/* === Tablet Responsive Tier", sectionStart);
    const mobileSection = css.slice(sectionStart, sectionEnd);

    const detailBodyMatch = mobileSection.match(/\.detail-body\s*\{[^}]*\}/s);
    expect(detailBodyMatch).toBeTruthy();
    expect(detailBodyMatch![0]).toContain("padding: 14px");
  });
});
