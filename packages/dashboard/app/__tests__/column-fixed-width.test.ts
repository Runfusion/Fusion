import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = readFileSync(resolve(__dirname, "../styles.css"), "utf-8");

describe("column fixed-width CSS", () => {
  // Extract the base .column { ... } block (not inside a media query)
  const columnBlock = css.match(/\.column\s*\{[^}]*\}/)![0];

  // Extract the .column-body { ... } block
  const columnBodyBlock = css.match(/\.column-body\s*\{[^}]*\}/)![0];

  // Extract the mobile media block
  const mediaStart = css.search(
    /@media\s*\([^)]*max-width:\s*768px[^)]*\)\s*\{/,
  );
  const mobileBlock = css.slice(mediaStart);

  describe("desktop .column", () => {
    it("has min-width: 0 (not 260px)", () => {
      expect(columnBlock).toContain("min-width: 0");
      expect(columnBlock).not.toContain("min-width: 260px");
    });

    it("still has overflow: hidden", () => {
      expect(columnBlock).toContain("overflow: hidden");
    });
  });

  describe(".column-body", () => {
    it("has overflow-x: hidden", () => {
      expect(columnBodyBlock).toContain("overflow-x: hidden");
    });
  });

  describe("desktop .board grid template", () => {
    it("uses repeat(6, minmax(260px, 1fr)) for 6 columns", () => {
      expect(css).toContain(
        "grid-template-columns: repeat(6, minmax(260px, 1fr))",
      );
    });
  });

  describe("mobile .board > .column", () => {
    it("has a fixed 280px width constraint", () => {
      // Accept either `width: 280px` or both min-width + max-width: 280px
      const hasFix =
        mobileBlock.includes("width: 280px") ||
        (mobileBlock.includes("min-width: 280px") &&
          mobileBlock.includes("max-width: 280px"));
      expect(hasFix).toBe(true);
    });
  });
});
