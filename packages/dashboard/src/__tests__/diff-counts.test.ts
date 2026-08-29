import { describe, it, expect } from "vitest";
import { countPatchLines } from "../routes/diff-counts.js";

describe("countPatchLines", () => {
  it.each([
    ["simple add/del", "+a\n-b\n", { additions: 1, deletions: 1 }],
    ["counts ++i content", "diff --git a/x b/x\n+++ b/x\n@@ -0,0 +1 @@\n++i;\n", { additions: 1, deletions: 0 }],
    ["counts --counter content", "diff --git a/x b/x\n--- a/x\n@@ -1 +1 @@\n--counter;\n", { additions: 0, deletions: 1 }],
    ["ignores file headers", "--- a/file.ts\n+++ b/file.ts\n", { additions: 0, deletions: 0 }],
    ["counts +++ in hunk body", "@@ -1 +1 @@\n+++\n", { additions: 1, deletions: 0 }],
    ["empty patch", "", { additions: 0, deletions: 0 }],
    ["only diff headers", "diff --git a/a b/a\nindex 123..456 100644\n", { additions: 0, deletions: 0 }],
  ])("%s", (_name, patch, expected) => {
    expect(countPatchLines(patch)).toEqual(expected);
  });
});
