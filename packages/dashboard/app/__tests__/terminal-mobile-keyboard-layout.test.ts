import { describe, it, expect } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

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

    const baseRuleMatch = afterSection.match(/^\s+\.modal\.terminal-modal\s*\{/m);
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
      // Match the first indented .modal.terminal-modal { ... } in this section
      const match = afterSection.match(
        /^\s+\.modal\.terminal-modal\s*\{([^}]*)\}/m,
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

    it("sets min-height: 100dvh on mobile", () => {
      const ruleBody = findMobileTerminalModalRule();
      expect(ruleBody).toContain("min-height: 100dvh");
    });
  });

  describe("desktop .modal.terminal-modal base rule", () => {
    /**
     * Extract the base desktop terminal modal rule (top-level, not inside
     * any @media block).
     *
     * The modal is `resize: both` and remembers user-chosen dimensions via
     * inline `style="width: …; height: …"`. To keep persisted size winning
     * over the CSS default, the *initial* width/height live in companion
     * rules (`:not([style*="width"])` / `:not([style*="height"])`), not in
     * this base block. The base block carries immutable constraints:
     * min/max sizing, flex layout, background.
     */
    function findDesktopTerminalModalRule(): string {
      const match = css.match(/^\.modal\.terminal-modal\s*\{([^}]*)\}/m);
      return match?.[1] ?? "";
    }

    /** Companion rule supplying the initial width when no inline
     *  `style="width: …"` has been persisted. */
    function findDesktopInitialWidthRule(): string {
      const match = css.match(
        /^\.modal\.terminal-modal:not\(\[style\*="width"\]\)\s*\{([^}]*)\}/m,
      );
      return match?.[1] ?? "";
    }

    /** Companion rule supplying the initial height when no inline
     *  `style="height: …"` has been persisted. */
    function findDesktopInitialHeightRule(): string {
      const match = css.match(
        /^\.modal\.terminal-modal:not\(\[style\*="height"\]\)\s*\{([^}]*)\}/m,
      );
      return match?.[1] ?? "";
    }

    it("uses viewport-based width with desktop side margins", () => {
      // Initial width (when no persisted size) lives in the companion rule.
      const initialWidth = findDesktopInitialWidthRule();
      expect(initialWidth).toContain(
        "width: min(1800px, calc(100vw - (var(--space-xl) * 2)))",
      );
      // max-width remains in the base rule so persisted sizes are clamped.
      const baseRule = findDesktopTerminalModalRule();
      expect(baseRule).toContain(
        "max-width: calc(100vw - (var(--space-xl) * 2))",
      );
    });

    it("does not cap desktop width to the old narrow 1600px max", () => {
      const baseRule = findDesktopTerminalModalRule();
      const initialWidth = findDesktopInitialWidthRule();
      expect(baseRule).not.toContain("max-width: 1600px");
      expect(initialWidth).not.toContain("max-width: 1600px");
    });

    it("keeps desktop height constraints", () => {
      // Initial height clamps to 85vh on first open before any resize.
      const initialHeight = findDesktopInitialHeightRule();
      expect(initialHeight).toContain("85vh");
      // Base rule supplies absolute resize bounds: a sensible floor and a
      // ceiling tied to the dynamic viewport.
      const baseRule = findDesktopTerminalModalRule();
      expect(baseRule).toMatch(/min-height:\s*[^;]+/);
      expect(baseRule).toContain("max-height: calc(100dvh - 40px)");
    });
  });
});
