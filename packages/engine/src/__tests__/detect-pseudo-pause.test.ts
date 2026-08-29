import { describe, it, expect } from "vitest";
import { detectPseudoPause, type PseudoPauseResult } from "../executor.js";

describe("detectPseudoPause", () => {
  describe("returns 'none' for empty/whitespace", () => {
    it("empty string", () => {
      const result = detectPseudoPause("");
      expect(result).toEqual({ kind: "none" });
    });

    it("whitespace only", () => {
      const result = detectPseudoPause("   \n\t  ");
      expect(result).toEqual({ kind: "none" });
    });
  });

  describe("returns 'none' for normal short prose", () => {
    it("normal short text without question", () => {
      const result = detectPseudoPause("This is just a normal statement about the work.");
      expect(result).toEqual({ kind: "none" });
    });

    it("short text ending with question", () => {
      const result = detectPseudoPause("Do you want this?");
      expect(result).toEqual({ kind: "none" });
    });

    it("text under 200 chars ending with question", () => {
      const text = "a".repeat(150) + "?";
      const result = detectPseudoPause(text);
      expect(result).toEqual({ kind: "none" });
    });
  });

  describe("detects regex patterns", () => {
    it('detects "if you want" pattern (regex match 1)', () => {
      const result = detectPseudoPause(
        "I've completed the first part. If you want, I can continue with the next section."
      );
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
      expect(result.matched?.toLowerCase()).toContain("if you want");
    });

    it('detects "should I continue" pattern (regex match 2)', () => {
      const result = detectPseudoPause(
        "The basic setup is done. Should I continue with the implementation?"
      );
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
      expect(result.matched?.toLowerCase()).toContain("should");
      expect(result.matched?.toLowerCase()).toContain("continue");
    });

    it('detects "let me know" pattern (regex match 3)', () => {
      const result = detectPseudoPause(
        "I've fixed the main issue. Let me know if you want me to run tests."
      );
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
      expect(result.matched?.toLowerCase()).toContain("let me know");
    });

    it('detects "want me to continue" pattern (regex match 4)', () => {
      const result = detectPseudoPause(
        "The framework is set up. Do you want me to continue with the API routes?"
      );
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
      expect(result.matched?.toLowerCase()).toContain("want");
    });

    it('detects "ready to proceed" pattern (regex match 5)', () => {
      const result = detectPseudoPause(
        "Configuration is complete. Ready to proceed with testing?"
      );
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
      expect(result.matched?.toLowerCase()).toContain("ready");
    });

    it('detects "shall I" pattern (regex match 6)', () => {
      const result = detectPseudoPause(
        "The server is running properly. Shall I deploy it now?"
      );
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
      expect(result.matched?.toLowerCase()).toContain("shall");
    });

    it('detects "awaiting approval" pattern (regex match 7)', () => {
      const result = detectPseudoPause(
        "All changes have been made according to spec. Awaiting your approval to merge."
      );
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
      expect(result.matched?.toLowerCase()).toContain("awaiting");
    });

    it("handles case-insensitive matching", () => {
      const result = detectPseudoPause(
        "The setup is done. IF YOU WANT, I can continue immediately."
      );
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
    });

    it("returns matched snippet with surrounding context (~120 chars)", () => {
      const result = detectPseudoPause(
        "Lorem ipsum dolor sit amet. If you want, I can continue with the implementation. This is additional text."
      );
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
      expect(result.matched!.length).toBeGreaterThan(10);
      expect(result.matched!.length).toBeLessThanOrEqual(150);
      expect(result.matched).toContain("If you want");
    });

    it("removes newlines from matched snippet", () => {
      const result = detectPseudoPause(
        "Some work done.\nIf you want,\nI can continue."
      );
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
      expect(result.matched).not.toContain("\n");
    });
  });

  describe("detects structural pseudo-pauses (>200 chars)", () => {
    it("long text ending with question mark", () => {
      const text = "a".repeat(250) + "?";
      const result = detectPseudoPause(text);
      expect(result.kind).toBe("structural");
      expect(result.matched).toBeDefined();
      expect(result.matched).toContain("?");
    });

    it("long text ending with ## Notes heading", () => {
      const text = "a".repeat(250) + "\n## Notes";
      const result = detectPseudoPause(text);
      expect(result.kind).toBe("structural");
      expect(result.matched).toBeDefined();
    });

    it("long text ending with ## Next steps heading", () => {
      const text = "a".repeat(250) + "\n## Next steps";
      const result = detectPseudoPause(text);
      expect(result.kind).toBe("structural");
      expect(result.matched).toBeDefined();
    });

    it("long text ending with ### Next steps: line", () => {
      const text = "a".repeat(250) + "\n### Next steps:";
      const result = detectPseudoPause(text);
      expect(result.kind).toBe("structural");
      expect(result.matched).toBeDefined();
    });

    it("long text ending with plain 'Next steps:' text", () => {
      const text = "a".repeat(250) + "\nNext steps:";
      const result = detectPseudoPause(text);
      expect(result.kind).toBe("structural");
      expect(result.matched).toBeDefined();
    });

    it("returns 'none' for long normal narrative without question/heading", () => {
      const text = "a".repeat(300);
      const result = detectPseudoPause(text);
      expect(result).toEqual({ kind: "none" });
    });
  });

  describe("real-world regression test", () => {
    it("detects FN-2978 pseudo-pause ending (if you want)", () => {
      const fn2978Text = `If you want, I can continue immediately and finish Steps 4–9 (dashboard backend/frontend wiring, daemon/serve/dashboard/engine integration, full gates \`pnpm lint && pnpm test && pnpm build\`, and changeset/doc/memory finalization).`;
      const result = detectPseudoPause(fn2978Text);
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
      expect(result.matched?.toLowerCase()).toContain("if you want");
    });
  });

  describe("edge cases", () => {
    it("handles text with only question marks", () => {
      const result = detectPseudoPause("???");
      expect(result.kind).toBe("none");
    });

    it("handles text with mixed whitespace", () => {
      const result = detectPseudoPause("\r\n  \t\r\n");
      expect(result).toEqual({ kind: "none" });
    });

    it("handles very long text with regex match", () => {
      const text = "a".repeat(5000) + " If you want, I can continue. " + "b".repeat(5000);
      const result = detectPseudoPause(text);
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
    });

    it("handles multiple matching patterns (returns first regex match)", () => {
      const text = "If you want to continue, should I proceed? Let me know.";
      const result = detectPseudoPause(text);
      expect(result.kind).toBe("regex");
      expect(result.matched).toBeDefined();
      expect(result.matched?.toLowerCase()).toContain("if you want");
    });

    it("prioritizes regex over structural detection", () => {
      const text = "a".repeat(250) + " If you want to continue?\n## Next steps";
      const result = detectPseudoPause(text);
      expect(result.kind).toBe("regex");
    });
  });
});
