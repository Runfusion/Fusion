import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

const css = loadAllAppCss();

describe("mobile planning input font size CSS", () => {
  describe("base (desktop) styles", () => {
    it("planning-textarea has desktop font-size below 16px", () => {
      // Extract the .planning-textarea rule
      const textareaMatch = css.match(/\.planning-textarea\s*\{[^}]*\}/);
      expect(textareaMatch).not.toBeNull();

      // Should have 14px font-size on desktop
      expect(textareaMatch![0]).toContain("font-size: 14px");
    });
  });

  describe("mobile @media (max-width: 768px)", () => {
    it("contains mobile font-size override for planning-textarea", () => {
      const planningTextarea16pxMatch = css.match(
        /\.planning-textarea\s*\{[^}]*font-size:\s*16px[^}]*\}/,
      );
      expect(planningTextarea16pxMatch).not.toBeNull();
      const matchIndex = css.indexOf(planningTextarea16pxMatch![0]);
      const cssBeforeMatch = css.slice(0, matchIndex);
      const lastMediaQuery = cssBeforeMatch.lastIndexOf("@media");
      expect(lastMediaQuery).toBeGreaterThanOrEqual(0);
      expect(cssBeforeMatch.slice(lastMediaQuery, lastMediaQuery + 80)).toContain("max-width: 768px");
    });

    it("applies 16px font-size globally to all text-entry controls on mobile", () => {
      // Mobile foundation now enforces iOS-safe 16px sizing for all text inputs/selects/textareas.
      const globalTextEntryPattern = /@media[^{]*max-width[^}]*\{[\s\S]*input\[type=\"text\"\][\s\S]*select,[\s\S]*textarea\s*\{[\s\S]*font-size:\s*16px/s;
      expect(css).toMatch(globalTextEntryPattern);
    });

    it("planning-textarea font-size is within the mobile media query", () => {
      // Find .planning-textarea font-size: 16px
      const planningTextarea16pxMatch = css.match(
        /\.planning-textarea\s*\{[^}]*font-size:\s*16px[^}]*\}/,
      );
      expect(planningTextarea16pxMatch).not.toBeNull();

      // Check it appears after a mobile media query
      const matchIndex = css.indexOf(planningTextarea16pxMatch![0]);
      const cssBeforeMatch = css.slice(0, matchIndex);
      const lastMediaQuery = cssBeforeMatch.lastIndexOf("@media");
      expect(lastMediaQuery).toBeGreaterThanOrEqual(0);

      // Verify the last media query before our rule is a mobile one
      const mediaQueryText = cssBeforeMatch.slice(lastMediaQuery, lastMediaQuery + 50);
      expect(mediaQueryText).toContain("max-width: 768px");
    });
  });
});
