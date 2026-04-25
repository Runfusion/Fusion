import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = loadAllAppCss();

describe("scroll-snap CSS", () => {
  describe("base (desktop) styles", () => {
    it("contains scroll-snap-type: x proximity on .board", () => {
      expect(css).toContain("scroll-snap-type: x proximity");
    });

    it("contains scroll-snap-align: center on .column", () => {
      // The base .column rule should include scroll-snap-align: center
      const columnBlockMatch = css.match(/\.column\s*\{[^}]*\}/);
      expect(columnBlockMatch).not.toBeNull();
      expect(columnBlockMatch![0]).toContain("scroll-snap-align: center");
    });

    it("contains scroll-padding-inline on .board", () => {
      expect(css).toContain("scroll-padding-inline");
    });
  });

  describe("mobile @media (max-width: 768px)", () => {
    // Extract the mobile media block for scoped assertions
    const mediaStart = css.search(
      /@media\s*\([^)]*max-width:\s*768px[^)]*\)\s*\{/,
    );
    const afterMedia = css.slice(mediaStart);

    it("contains scroll-snap-type: x mandatory", () => {
      expect(css).toContain("scroll-snap-type: x mandatory");
    });

    it("contains scroll-snap-align: center (not start)", () => {
      expect(afterMedia).toContain("scroll-snap-align: center");
      expect(afterMedia).not.toContain("scroll-snap-align: start");
    });

    it("contains -webkit-overflow-scrolling: touch", () => {
      expect(css).toContain("-webkit-overflow-scrolling: touch");
    });

    it("contains flex-shrink: 0", () => {
      expect(css).toContain("flex-shrink: 0");
    });

    it("contains scroll-padding-inline in the media block", () => {
      expect(afterMedia).toContain("scroll-padding-inline");
    });

    it("scroll-snap rules are inside a @media block", () => {
      expect(mediaStart).toBeGreaterThanOrEqual(0);
      expect(afterMedia).toContain("scroll-snap-type: x mandatory");
      expect(afterMedia).toContain("scroll-snap-align: center");
    });
  });

  describe("card touch-action", () => {
    it("allows horizontal panning so board swipes work when starting on a card", () => {
      const cardBlockMatch = css.match(/\.card\s*\{[^}]*\}/s);
      expect(cardBlockMatch).not.toBeNull();
      expect(cardBlockMatch![0]).toContain("touch-action: pan-x pan-y");
    });

    it("does not use touch-action: pan-y alone (which blocks horizontal swipes)", () => {
      // The card should NOT have just pan-y; it needs pan-x too
      const cardBlockMatch = css.match(/\.card\s*\{[^}]*\}/s);
      expect(cardBlockMatch).not.toBeNull();
      const cardBlock = cardBlockMatch![0];
      expect(cardBlock).not.toMatch(/touch-action:\s*pan-y\s*;/);
    });
  });
});
