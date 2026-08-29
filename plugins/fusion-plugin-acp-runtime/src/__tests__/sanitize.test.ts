import { describe, it, expect } from "vitest";
import {
  stripControlSequences,
  boundString,
  boundIdentifier,
  DEFAULT_IDENTIFIER_MAX,
  TRUNCATION_MARKER,
} from "../sanitize.js";

describe("stripControlSequences", () => {
  it("removes CSI/SGR ANSI color escapes", () => {
    const input = "\x1b[31mred\x1b[0m text";
    expect(stripControlSequences(input)).toBe("red text");
  });

  it("removes OSC sequences (title-set injection)", () => {
    const input = "before\x1b]0;malicious title\x07after";
    expect(stripControlSequences(input)).toBe("beforeafter");
  });

  it("removes bare ESC and cursor-move escapes", () => {
    const input = "a\x1b[2Jb\x1b[Hc";
    expect(stripControlSequences(input)).toBe("abc");
  });

  it("drops C0/C1 control chars and DEL but keeps \\n and \\t", () => {
    const input = "line1\nline2\tend\x00\x07\x7f\x9b";
    expect(stripControlSequences(input)).toBe("line1\nline2\tend");
  });

  it("returns empty string for non-string / empty input", () => {
    expect(stripControlSequences("")).toBe("");
    // @ts-expect-error intentionally wrong type
    expect(stripControlSequences(undefined)).toBe("");
    // @ts-expect-error intentionally wrong type
    expect(stripControlSequences(123)).toBe("");
  });

  it("leaves clean printable text untouched", () => {
    expect(stripControlSequences("hello world 123 #$%")).toBe("hello world 123 #$%");
  });
});

describe("boundString", () => {
  it("returns input unchanged when within max", () => {
    expect(boundString("short", 100)).toBe("short");
  });

  it("truncates and appends the marker when over max", () => {
    const out = boundString("a".repeat(100), 50);
    expect(out.length).toBe(50);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("never exceeds max length", () => {
    const out = boundString("x".repeat(1000), 20);
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it("handles max <= marker length by hard slice", () => {
    const out = boundString("abcdefgh", 3);
    expect(out).toBe("abc");
  });

  it("returns empty for non-positive max or empty/non-string input", () => {
    expect(boundString("abc", 0)).toBe("");
    expect(boundString("abc", -5)).toBe("");
    expect(boundString("", 10)).toBe("");
    // @ts-expect-error intentionally wrong type
    expect(boundString(undefined, 10)).toBe("");
  });
});

describe("boundIdentifier", () => {
  it("replaces path separators so the id cannot escape into a path", () => {
    const out = boundIdentifier("../../etc/passwd");
    expect(out).not.toContain("/");
    expect(out).not.toContain("\\");
    expect(out).not.toContain("..");
  });

  it("normalizes backslash separators and traversal", () => {
    const out = boundIdentifier("..\\..\\windows\\system32");
    expect(out).not.toContain("\\");
    expect(out).not.toContain("..");
  });

  it("strips NUL bytes and control chars", () => {
    const out = boundIdentifier("sess\x00ion\x1b[31mid");
    expect(out).not.toContain("\x00");
    expect(out).not.toContain("\x1b");
    expect(out).toContain("session");
  });

  it("bounds length to the default cap", () => {
    const out = boundIdentifier("s".repeat(10_000));
    expect(out.length).toBe(DEFAULT_IDENTIFIER_MAX);
  });

  it("honors an explicit max", () => {
    expect(boundIdentifier("abcdefgh", 4)).toBe("abcd");
  });

  it("passes a clean opaque id through unchanged", () => {
    expect(boundIdentifier("sess-1234-abcd")).toBe("sess-1234-abcd");
  });

  it("returns empty for empty / non-string input", () => {
    expect(boundIdentifier("")).toBe("");
    // @ts-expect-error intentionally wrong type
    expect(boundIdentifier(undefined)).toBe("");
  });
});
