import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = readFileSync(resolve(__dirname, "../styles.css"), "utf-8");

describe("detail-body mobile overflow (FN-1331)", () => {
  it("base .detail-body includes overflow-x: hidden to prevent horizontal scrolling", () => {
    // Find base .detail-body (before mobile section)
    const mobileSectionStart = css.indexOf("/* === Mobile Responsive Overrides ===");
    expect(mobileSectionStart).toBeGreaterThan(-1);

    const baseCss = css.slice(0, mobileSectionStart);

    // Extract base .detail-body block using non-greedy pattern
    const detailBodyMatch = baseCss.match(/\.detail-body\s*\{[^}]*\}/);
    expect(detailBodyMatch).toBeTruthy();
    const rule = detailBodyMatch![0];
    expect(rule).toContain("overflow-x: hidden");
    expect(rule).toContain("overflow-y: auto");
  });

  it("mobile .detail-body includes overflow-x: hidden and preserves overflow-y: auto", () => {
    // Find the main mobile responsive overrides section
    const sectionStart = css.indexOf("/* === Mobile Responsive Overrides ===");
    const sectionEnd = css.indexOf("/* === Tablet Responsive Tier", sectionStart);
    expect(sectionStart).toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);

    const mobileSection = css.slice(sectionStart, sectionEnd);

    // Extract .detail-body block within the mobile section using non-greedy pattern
    const detailBodyMatch = mobileSection.match(/\.detail-body\s*\{[^}]*\}/s);
    expect(detailBodyMatch).toBeTruthy();
    const rule = detailBodyMatch![0];
    expect(rule).toContain("overflow-x: hidden");
    expect(rule).toContain("overflow-y: auto");
  });

  it("mobile .detail-body rule preserves padding: 14px", () => {
    const sectionStart = css.indexOf("/* === Mobile Responsive Overrides ===");
    const sectionEnd = css.indexOf("/* === Tablet Responsive Tier", sectionStart);
    const mobileSection = css.slice(sectionStart, sectionEnd);

    const detailBodyMatch = mobileSection.match(/\.detail-body\s*\{[^}]*\}/s);
    expect(detailBodyMatch).toBeTruthy();
    expect(detailBodyMatch![0]).toContain("padding: 14px");
  });
});
