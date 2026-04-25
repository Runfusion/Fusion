import { describe, it, expect } from "vitest";
import { highlightDiff } from "../highlightDiff";
import React from "react";

type ElProps = { className?: string; children?: React.ReactNode };
const propsOf = (el: React.ReactNode): ElProps =>
  (el as React.ReactElement<ElProps>).props as ElProps;
const typeOf = (el: React.ReactNode) =>
  (el as React.ReactElement).type;

describe("highlightDiff", () => {
  it("applies diff-add class to added lines starting with +", () => {
    const result = highlightDiff("+hello world");
    expect(result).toHaveLength(1);

    expect(typeOf(result[0])).toBe("span");
    expect(propsOf(result[0]).className).toBe("diff-add");
    expect(propsOf(result[0]).children).toBe("+hello world\n");
  });

  it("applies diff-del class to removed lines starting with -", () => {
    const result = highlightDiff("-world");
    expect(result).toHaveLength(1);

    expect(typeOf(result[0])).toBe("span");
    expect(propsOf(result[0]).className).toBe("diff-del");
    expect(propsOf(result[0]).children).toBe("-world\n");
  });

  it("applies diff-hunk class to hunk headers starting with @@", () => {
    const result = highlightDiff("@@ -1,5 +1,6 @@ function");
    expect(result).toHaveLength(1);

    expect(typeOf(result[0])).toBe("span");
    expect(propsOf(result[0]).className).toBe("diff-hunk");
    expect(propsOf(result[0]).children).toBe("@@ -1,5 +1,6 @@ function\n");
  });

  it("does not apply special class to context lines", () => {
    const result = highlightDiff("  context line");
    expect(result).toHaveLength(1);

    // Context lines should be returned as plain text fragments
    expect(typeOf(result[0])).toBe(React.Fragment);
    expect(propsOf(result[0]).children).toBe("  context line\n");
  });

  it("does not apply diff-add class to +++ lines", () => {
    const result = highlightDiff("+++ b/file.ts");
    expect(result).toHaveLength(1);

    expect(typeOf(result[0])).toBe(React.Fragment);
    expect(propsOf(result[0]).children).toBe("+++ b/file.ts\n");
  });

  it("does not apply diff-del class to --- lines", () => {
    const result = highlightDiff("--- a/file.ts");
    expect(result).toHaveLength(1);

    expect(typeOf(result[0])).toBe(React.Fragment);
    expect(propsOf(result[0]).children).toBe("--- a/file.ts\n");
  });

  it("renders multiple lines correctly with different classes", () => {
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 context line
+added line
-deleted line
  another context`;

    const result = highlightDiff(diff);

    expect(result).toHaveLength(8);

    // Line 0: diff --git - plain fragment
    expect(typeOf(result[0])).toBe(React.Fragment);

    // Line 1: --- a/file.ts - plain fragment (not diff-del)
    expect(typeOf(result[1])).toBe(React.Fragment);

    // Line 2: +++ b/file.ts - plain fragment (not diff-add)
    expect(typeOf(result[2])).toBe(React.Fragment);

    // Line 3: @@ hunk header - diff-hunk
    expect(typeOf(result[3])).toBe("span");
    expect(propsOf(result[3]).className).toBe("diff-hunk");

    // Line 4: context - plain fragment
    expect(typeOf(result[4])).toBe(React.Fragment);

    // Line 5: +added - diff-add
    expect(typeOf(result[5])).toBe("span");
    expect(propsOf(result[5]).className).toBe("diff-add");

    // Line 6: -deleted - diff-del
    expect(typeOf(result[6])).toBe("span");
    expect(propsOf(result[6]).className).toBe("diff-del");

    // Line 7: another context - plain fragment
    expect(typeOf(result[7])).toBe(React.Fragment);
  });

  it("renders empty diff without errors", () => {
    const result = highlightDiff("");
    expect(result).toHaveLength(1);

    // Empty string becomes single element with empty line
    expect(typeOf(result[0])).toBe(React.Fragment);
    expect(propsOf(result[0]).children).toBe("\n");
  });

  it("handles single line without newline", () => {
    const result = highlightDiff("+single line");
    expect(result).toHaveLength(1);

    expect(typeOf(result[0])).toBe("span");
    expect(propsOf(result[0]).className).toBe("diff-add");
    expect(propsOf(result[0]).children).toBe("+single line\n");
  });

  it("handles diff header lines correctly", () => {
    const diff = `diff --git a/src/index.ts b/src/index.ts
index 1234567..abcdefg 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -10,6 +10,7 @@ export`;

    const result = highlightDiff(diff);

    // 5 lines total (split by \n)
    expect(result).toHaveLength(5);

    // All header lines should be plain fragments, not diff-add/diff-del
    expect(typeOf(result[0])).toBe(React.Fragment);
    expect(typeOf(result[1])).toBe(React.Fragment);
    expect(typeOf(result[2])).toBe(React.Fragment); // --- a/src/index.ts
    expect(typeOf(result[3])).toBe(React.Fragment); // +++ b/src/index.ts
    expect(typeOf(result[4])).toBe("span");
    expect(propsOf(result[4]).className).toBe("diff-hunk");
  });
});
