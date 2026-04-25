import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

const css = loadAllAppCss();

describe("mobile input font size CSS", () => {
  describe("base (desktop) styles", () => {
    it("quick-entry-input has desktop font-size below 16px", () => {
      // Extract the .quick-entry-input rule
      const quickEntryMatch = css.match(/\.quick-entry-input\s*\{[^}]*\}/);
      expect(quickEntryMatch).not.toBeNull();
      
      // Should have 13px font-size on desktop
      expect(quickEntryMatch![0]).toContain("font-size: 13px");
    });

    it("form-group textarea has desktop font-size below 16px", () => {
      // Extract the .form-group textarea rule
      const textareaMatch = css.match(/\.form-group\s+textarea\s*\{[^}]*\}/);
      expect(textareaMatch).not.toBeNull();
      
      // Should have 14px font-size on desktop
      expect(textareaMatch![0]).toContain("font-size: 14px");
    });
  });

  describe("mobile @media (max-width: 768px)", () => {
    // Extract the main mobile media block for scoped assertions
    const mediaStart = css.search(
      /@media\s*\([^)]*max-width:\s*768px[^)]*\)\s*\{/,
    );
    const afterMedia = css.slice(mediaStart);

    it("contains mobile font-size override for global text-entry controls", () => {
      expect(afterMedia).toContain('input[type="text"],');
      expect(afterMedia).toContain('input[type="search"],');
      expect(afterMedia).toContain('input[type="tel"],');
      expect(afterMedia).toContain("input:not([type]),");
      expect(afterMedia).toContain("select,");
      expect(afterMedia).toContain("textarea {");
      expect(afterMedia).toContain("font-size: 16px");
    });

    it("global text-entry font-size override is inside the mobile @media block", () => {
      expect(mediaStart).toBeGreaterThanOrEqual(0);

      // Find the next @media after the main mobile one to scope our search
      const nextMedia = afterMedia.search(/@media/);
      const mobileBlock = nextMedia > 0 ? afterMedia.slice(0, nextMedia) : afterMedia;

      expect(mobileBlock).toContain('input[type="text"],');
      expect(mobileBlock).toContain("font-size: 16px");
    });

    it("applies 16px sizing globally rather than only quick-entry fields", () => {
      const globalInputPattern = /@media[^{]*max-width[^}]*\{[\s\S]*input\[type=\"text\"\][\s\S]*font-size:\s*16px/s;
      expect(css).toMatch(globalInputPattern);
    });
  });
});
