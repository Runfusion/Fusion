import { describe, it, expect } from "vitest";
import { highlightDiff } from "./highlightDiff";
import React from "react";

describe("highlightDiff", () => {
  it("applies diff-add class to added lines starting with +", () => {
    const result = highlightDiff("+hello world");
    expect(result).toHaveLength(1);

    const span = result[0] as React.ReactElement;
    expect(span.type).toBe("span");
    expect(span.props.className).toBe("diff-add");
    expect(span.props.children).toBe("+hello world\n");
  });

  it("applies diff-del class to removed lines starting with -", () => {
    const result = highlightDiff("-world");
    expect(result).toHaveLength(1);

    const span = result[0] as React.ReactElement;
    expect(span.type).toBe("span");
    expect(span.props.className).toBe("diff-del");
    expect(span.props.children).toBe("-world\n");
  });

  it("applies diff-hunk class to hunk headers starting with @@", () => {
    const result = highlightDiff("@@ -1,5 +1,6 @@ function");
    expect(result).toHaveLength(1);

    const span = result[0] as React.ReactElement;
    expect(span.type).toBe("span");
    expect(span.props.className).toBe("diff-hunk");
    expect(span.props.children).toBe("@@ -1,5 +1,6 @@ function\n");
  });

  it("does not apply special class to context lines", () => {
    const result = highlightDiff("  context line");
    expect(result).toHaveLength(1);

    // Context lines should be returned as plain text fragments
    const fragment = result[0] as React.ReactElement;
    expect(fragment.type).toBe(React.Fragment);
    expect(fragment.props.children).toBe("  context line\n");
  });

  it("does not apply diff-add class to +++ lines", () => {
    const result = highlightDiff("+++ b/file.ts");
    expect(result).toHaveLength(1);

    const fragment = result[0] as React.ReactElement;
    expect(fragment.type).toBe(React.Fragment);
    expect(fragment.props.children).toBe("+++ b/file.ts\n");
  });

  it("does not apply diff-del class to --- lines", () => {
    const result = highlightDiff("--- a/file.ts");
    expect(result).toHaveLength(1);

    const fragment = result[0] as React.ReactElement;
    expect(fragment.type).toBe(React.Fragment);
    expect(fragment.props.children).toBe("--- a/file.ts\n");
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
    expect((result[0] as React.ReactElement).type).toBe(React.Fragment);

    // Line 1: --- a/file.ts - plain fragment (not diff-del)
    expect((result[1] as React.ReactElement).type).toBe(React.Fragment);

    // Line 2: +++ b/file.ts - plain fragment (not diff-add)
    expect((result[2] as React.ReactElement).type).toBe(React.Fragment);

    // Line 3: @@ hunk header - diff-hunk
    const hunkLine = result[3] as React.ReactElement;
    expect(hunkLine.type).toBe("span");
    expect(hunkLine.props.className).toBe("diff-hunk");

    // Line 4: context - plain fragment
    expect((result[4] as React.ReactElement).type).toBe(React.Fragment);

    // Line 5: +added - diff-add
    const addedLine = result[5] as React.ReactElement;
    expect(addedLine.type).toBe("span");
    expect(addedLine.props.className).toBe("diff-add");

    // Line 6: -deleted - diff-del
    const deletedLine = result[6] as React.ReactElement;
    expect(deletedLine.type).toBe("span");
    expect(deletedLine.props.className).toBe("diff-del");

    // Line 7: another context - plain fragment
    expect((result[7] as React.ReactElement).type).toBe(React.Fragment);
  });

  it("renders empty diff without errors", () => {
    const result = highlightDiff("");
    expect(result).toHaveLength(1);

    // Empty string becomes single element with empty line
    const fragment = result[0] as React.ReactElement;
    expect(fragment.type).toBe(React.Fragment);
    expect(fragment.props.children).toBe("\n");
  });

  it("handles single line without newline", () => {
    const result = highlightDiff("+single line");
    expect(result).toHaveLength(1);

    const span = result[0] as React.ReactElement;
    expect(span.type).toBe("span");
    expect(span.props.className).toBe("diff-add");
    expect(span.props.children).toBe("+single line\n");
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
    expect((result[0] as React.ReactElement).type).toBe(React.Fragment);
    expect((result[1] as React.ReactElement).type).toBe(React.Fragment);
    expect((result[2] as React.ReactElement).type).toBe(React.Fragment); // --- a/src/index.ts
    expect((result[3] as React.ReactElement).type).toBe(React.Fragment); // +++ b/src/index.ts
    expect((result[4] as React.ReactElement).type).toBe("span");
    expect((result[4] as React.ReactElement).props.className).toBe("diff-hunk");
  });
});
