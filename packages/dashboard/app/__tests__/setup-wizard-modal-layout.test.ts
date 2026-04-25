import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = loadAllAppCss();

describe("setup-wizard-modal-layout (FN-2221)", () => {
  /**
   * Finds all CSS rule blocks for a given selector, returning their positions.
   * Works by scanning for the selector and matching balanced braces.
   */
  function findAllRuleBlocks(
    source: string,
    selector: string
  ): Array<{ start: number; end: number; block: string; inMediaQuery: boolean }> {
    const results: Array<{
      start: number;
      end: number;
      block: string;
      inMediaQuery: boolean;
    }> = [];
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escapedSelector + "\\s*\\{", "g");

    let match;
    while ((match = regex.exec(source)) !== null) {
      const start = match.index;
      const braceStart = start + match[0].length;

      // Find matching closing brace
      let depth = 1;
      let pos = braceStart;
      while (pos < source.length && depth > 0) {
        if (source[pos] === "{") depth++;
        else if (source[pos] === "}") depth--;
        pos++;
      }

      const end = pos;
      const block = source.slice(start, end);

      // Check if this rule is inside a media query
      // Search backwards for the nearest @media
      let before = source.slice(0, start);
      const lastMediaQuery = before.lastIndexOf("@media");
      let inMediaQuery = false;
      if (lastMediaQuery !== -1) {
        // Check if there's a closing brace between the @media and this rule
        const afterMedia = before.slice(lastMediaQuery);
        const openBraces = (afterMedia.match(/\{/g) || []).length;
        const closeBraces = (afterMedia.match(/\}/g) || []).length;
        inMediaQuery = openBraces > closeBraces;
      }

      results.push({ start, end, block, inMediaQuery });
    }

    return results;
  }

  describe("modal shell constraints (.setup-wizard-modal)", () => {
    it("base rule establishes flex context with display: flex and flex-direction: column", () => {
      const rules = findAllRuleBlocks(css, ".setup-wizard-modal");
      // Find the base rule (not in media query)
      const baseRules = rules.filter((r) => !r.inMediaQuery);
      expect(baseRules.length).toBeGreaterThan(0);

      const rule = baseRules[0].block;
      expect(rule).toContain("display: flex");
      expect(rule).toContain("flex-direction: column");
    });

    it("has viewport-bounded max-height to prevent off-screen rendering", () => {
      const rules = findAllRuleBlocks(css, ".setup-wizard-modal");
      const baseRules = rules.filter((r) => !r.inMediaQuery);
      expect(baseRules.length).toBeGreaterThan(0);

      const rule = baseRules[0].block;
      // Should use viewport-relative max-height (calc with 100dvh or similar)
      expect(rule).toMatch(/max-height:.*100dvh/i);
    });

    it("has overflow: hidden to contain scrollable content", () => {
      const rules = findAllRuleBlocks(css, ".setup-wizard-modal");
      const baseRules = rules.filter((r) => !r.inMediaQuery);
      expect(baseRules.length).toBeGreaterThan(0);

      const rule = baseRules[0].block;
      expect(rule).toContain("overflow: hidden");
    });

    it("mobile version also establishes flex context", () => {
      const rules = findAllRuleBlocks(css, ".setup-wizard-modal");
      // Find the mobile rule (in media query)
      const mobileRules = rules.filter((r) => r.inMediaQuery);
      expect(mobileRules.length).toBeGreaterThan(0);

      // Find the setup wizard mobile rule by checking it contains viewport-bounded max-height
      const setupWizardMobile = mobileRules.find((r) =>
        r.block.includes("100dvh")
      );
      expect(setupWizardMobile).toBeDefined();
      expect(setupWizardMobile!.block).toContain("display: flex");
      expect(setupWizardMobile!.block).toContain("flex-direction: column");
    });
  });

  describe("internal content scrolling (.setup-wizard-content)", () => {
    it("is a shrinkable scroll region with flex: 1 and min-height: 0", () => {
      const rules = findAllRuleBlocks(css, ".setup-wizard-content");
      const baseRules = rules.filter((r) => !r.inMediaQuery);
      expect(baseRules.length).toBeGreaterThan(0);

      const rule = baseRules[0].block;
      expect(rule).toContain("flex: 1");
      expect(rule).toContain("min-height: 0");
    });

    it("has overflow-y: auto for internal scrolling", () => {
      const rules = findAllRuleBlocks(css, ".setup-wizard-content");
      const baseRules = rules.filter((r) => !r.inMediaQuery);
      expect(baseRules.length).toBeGreaterThan(0);

      const rule = baseRules[0].block;
      expect(rule).toContain("overflow-y: auto");
    });
  });

  describe("non-collapsing footer (.setup-wizard-footer)", () => {
    it("has flex-shrink: 0 to prevent footer collapse", () => {
      const rules = findAllRuleBlocks(css, ".setup-wizard-footer");
      const baseRules = rules.filter((r) => !r.inMediaQuery);
      expect(baseRules.length).toBeGreaterThan(0);

      const rule = baseRules[0].block;
      expect(rule).toContain("flex-shrink: 0");
    });
  });

  describe("non-collapsing header (.setup-wizard-header)", () => {
    it("has flex-shrink: 0 to prevent header collapse", () => {
      const rules = findAllRuleBlocks(css, ".setup-wizard-header");
      const baseRules = rules.filter((r) => !r.inMediaQuery);
      expect(baseRules.length).toBeGreaterThan(0);

      const rule = baseRules[0].block;
      expect(rule).toContain("flex-shrink: 0");
    });
  });
});
