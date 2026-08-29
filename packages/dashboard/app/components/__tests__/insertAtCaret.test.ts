import { describe, expect, it } from "vitest";
import { computeInsertion, replaceRange } from "../insertAtCaret";

describe("dictation insertion", () => {
  it("inserts at empty, start, middle, and end", () => {
    expect(computeInsertion({ value: "", selectionStart: 0, selectionEnd: 0, insertText: "hello" })).toMatchObject({ nextValue: "hello", nextCaret: 5 });
    expect(computeInsertion({ value: "world", selectionStart: 0, selectionEnd: 0, insertText: "hello " }).nextValue).toBe("hello world");
    expect(computeInsertion({ value: "ab", selectionStart: 1, selectionEnd: 1, insertText: "X" }).nextValue).toBe("aXb");
    expect(computeInsertion({ value: "a", selectionStart: 1, selectionEnd: 1, insertText: "b" }).nextValue).toBe("ab");
  });
  it("replaces active selections and repeated previews", () => {
    const first = computeInsertion({ value: "before after", selectionStart: 7, selectionEnd: 12, insertText: "one" });
    const second = replaceRange({ value: first.nextValue, anchor: first.anchor, nextText: "two words" });
    const final = replaceRange({ value: second.nextValue, anchor: second.anchor, nextText: "final" });
    expect(first.nextValue).toBe("before one");
    expect(second.nextValue).toBe("before two words");
    expect(final.nextValue).toBe("before final");
    expect(final.anchor).toEqual({ start: 7, end: 12 });
  });
  it("preserves intervening text when its caller shifts an anchor for a prior edit", () => {
    const first = computeInsertion({ value: "after", selectionStart: 0, selectionEnd: 0, insertText: "partial" });
    const shifted = { start: first.anchor.start + 7, end: first.anchor.end + 7 };
    expect(replaceRange({ value: "prefix partialafter", anchor: shifted, nextText: "final" }).nextValue).toBe("prefix finalafter");
  });
});
