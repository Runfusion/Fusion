import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = readFileSync(
  resolve(__dirname, "../styles.css"),
  "utf-8",
);

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
      // Find the mobile planning modal media query
      const planningModalMediaMatch = css.match(
        /@media\s*\([^)]*max-width:\s*768px[^)]*\)\s*\{[^}]*\.planning-modal/s,
      );
      expect(planningModalMediaMatch).not.toBeNull();

      // Extract the mobile planning modal block
      const mediaStart = css.search(
        /@media\s*\([^)]*max-width:\s*768px[^)]*\)\s*\{[^}]*\.planning-modal/s,
      );
      const afterMedia = css.slice(mediaStart);

      // Find the end of this specific media block (next @media or end of string)
      const nextMedia = afterMedia.slice(1).search(/@media/);
      const mobileBlock = nextMedia > 0 ? afterMedia.slice(0, nextMedia + 1) : afterMedia;

      // Should contain .planning-textarea with 16px font-size
      expect(mobileBlock).toContain(".planning-textarea");
      expect(mobileBlock).toContain("font-size: 16px");
    });

    it("only targets planning mode textareas, not all textareas globally", () => {
      // The selector should specifically target .planning-textarea
      // not a global textarea selector that would affect all textareas
      // Match bare textarea selector (not .something-textarea)
      const globalTextareaPattern = /@media[^{]*max-width[^}]*\{[^}]*\stextarea\s*\{[^}]*font-size:\s*16px/s;
      expect(css).not.toMatch(globalTextareaPattern);
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
