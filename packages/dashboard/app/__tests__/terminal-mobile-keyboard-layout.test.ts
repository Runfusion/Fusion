import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * CSS contract tests for the terminal modal mobile keyboard-open layout.
 *
 * These tests parse the compiled CSS to assert that the keyboard-open
 * selector includes all three declarations needed to fully constrain
 * the modal height above the on-screen keyboard:
 *
 *   1. min-height: auto    — neutralizes inherited desktop min-height (90vh)
 *   2. height: <expr>      — sets exact height to visual viewport
 *   3. max-height: <expr>  — caps height at visual viewport
 *
 * Without any one of these, the modal can extend below the keyboard.
 */
const css = loadAllAppCss();

describe("terminal mobile keyboard layout CSS contract", () => {
  // Extract the mobile @media block
  const mediaMatch = css.match(
    /@media\s*\([^)]*max-width:\s*768px[^)]*\)\s*\{/,
  );
  const mediaStart = mediaMatch ? css.indexOf(mediaMatch[0]) : -1;

  // The keyboard-open selector is nested inside the mobile @media block.
  // Find it within the CSS text.
  const keyboardOpenSelectorPattern =
    /\.terminal-modal\[style\*="--keyboard-overlap"\]/;

  /**
   * Helper: find the rule block for the keyboard-open selector inside the
   * terminal modal's mobile media query. Returns the declarations block text.
   */
  function findKeyboardOpenRule(): string {
    const searchFrom = terminalMediaStart >= 0 ? terminalMediaStart : 0;
    const selectorMatch = css
      .slice(searchFrom)
      .match(
        new RegExp(
          keyboardOpenSelectorPattern.source +
            /\s*\{([^}]*)\}/.source,
        ),
      );
    return selectorMatch?.[1] ?? "";
  }

  /**
   * Find the terminal-modal mobile @media block. The terminal modal mobile
   * responsive section starts with a comment "=== Terminal Modal Mobile Responsive ===".
   */
  const terminalMobileComment = "Terminal Modal Mobile Responsive";
  const terminalMediaStart = css.indexOf(terminalMobileComment);

  // The shared expression for height and max-height
  const viewportExpression =
    "var(--vv-height, calc(100dvh - var(--keyboard-overlap, 0px)))";

  it("keyboard-open selector exists inside mobile @media block", () => {
    expect(mediaStart).toBeGreaterThanOrEqual(0);

    const afterMedia = css.slice(mediaStart);
    expect(afterMedia).toMatch(keyboardOpenSelectorPattern);
  });

  it("keyboard-open selector includes min-height: auto", () => {
    const ruleBody = findKeyboardOpenRule();
    expect(ruleBody).toContain("min-height: auto");
  });

  it("keyboard-open selector includes height with viewport/overlap expression", () => {
    const ruleBody = findKeyboardOpenRule();
    // height must use the same expression as max-height
    expect(ruleBody).toContain(`height: ${viewportExpression}`);
  });

  it("keyboard-open selector includes max-height with viewport/overlap expression", () => {
    const ruleBody = findKeyboardOpenRule();
    expect(ruleBody).toContain(`max-height: ${viewportExpression}`);
  });

  it("keyboard-open selector includes overflow: hidden to clip content during keyboard transition", () => {
    const ruleBody = findKeyboardOpenRule();
    expect(ruleBody).toContain("overflow: hidden");
  });

  it("height and max-height use the identical expression", () => {
    const ruleBody = findKeyboardOpenRule();

    // Count occurrences of the expression — should appear exactly twice
    const occurrences = ruleBody.split(viewportExpression).length - 1;
    expect(occurrences).toBe(2);
  });

  it("keyboard-open selector appears after the base mobile .terminal-modal rule", () => {
    // The keyboard-open rule should override the base mobile rule,
    // so it must appear later in the stylesheet.
    const afterSection = css.slice(terminalMediaStart);

    const baseRuleMatch = afterSection.match(/^\s+\.terminal-modal\s*\{/m);
    const keyboardMatch = afterSection.match(keyboardOpenSelectorPattern);

    expect(baseRuleMatch).not.toBeNull();
    expect(keyboardMatch).not.toBeNull();

    const basePos = afterSection.indexOf(baseRuleMatch![0]);
    const keyboardPos = afterSection.indexOf(keyboardMatch![0]);

    expect(keyboardPos).toBeGreaterThan(basePos);
  });

  describe("base mobile .terminal-modal rule", () => {
    /**
     * Extract the .terminal-modal rule inside the terminal modal's mobile
     * @media block. This is the indented `.terminal-modal {` that appears
     * after the "Terminal Modal Mobile Responsive" comment.
     */
    function findMobileTerminalModalRule(): string {
      const searchFrom = terminalMediaStart >= 0 ? terminalMediaStart : 0;
      const afterSection = css.slice(searchFrom);
      // Match the first indented .terminal-modal { ... } in this section
      const match = afterSection.match(
        /^\s+\.terminal-modal\s*\{([^}]*)\}/m,
      );
      return match?.[1] ?? "";
    }

    it("sets width: 100% on mobile", () => {
      const ruleBody = findMobileTerminalModalRule();
      expect(ruleBody).toContain("width: 100%");
    });

    it("sets height: 100dvh on mobile", () => {
      const ruleBody = findMobileTerminalModalRule();
      expect(ruleBody).toContain("height: 100dvh");
    });

    it("sets max-height: 100dvh on mobile", () => {
      const ruleBody = findMobileTerminalModalRule();
      expect(ruleBody).toContain("max-height: 100dvh");
    });
  });

  describe("desktop .modal.terminal-modal base rule", () => {
    /**
     * Extract the desktop terminal modal rule (top-level, not inside any
     * @media block).
     */
    function findDesktopTerminalModalRule(): string {
      const match = css.match(/^\.modal\.terminal-modal\s*\{([^}]*)\}/m);
      return match?.[1] ?? "";
    }

    it("has min-height: 80vh on desktop", () => {
      const ruleBody = findDesktopTerminalModalRule();
      expect(ruleBody).toContain("min-height: 80vh");
    });

    it("has max-height: 85vh on desktop", () => {
      const ruleBody = findDesktopTerminalModalRule();
      expect(ruleBody).toContain("max-height: 85vh");
    });
  });
});
