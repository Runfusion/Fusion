import { describe, expect, it } from "vitest";
import { classifyTransientMergeError } from "../transient-merge-error-classifier.js";

describe("classifyTransientMergeError", () => {
  it("returns null for empty or missing errors", () => {
    expect(classifyTransientMergeError(null)).toBeNull();
    expect(classifyTransientMergeError(undefined)).toBeNull();
    expect(classifyTransientMergeError("")).toBeNull();
  });

  it("classifies process spawn cwd failures without over-matching bare errno prose", () => {
    expect(classifyTransientMergeError("spawn ENOTDIR")).toBe("process-spawn-failure");
    expect(classifyTransientMergeError("spawn git ENOENT")).toBe("process-spawn-failure");
    expect(classifyTransientMergeError("spawn ENOENT")).toBe("process-spawn-failure");
    expect(classifyTransientMergeError("Bash tool failed: spawn node ENOTDIR while starting merge verification"))
      .toBe("process-spawn-failure");

    expect(classifyTransientMergeError("ENOTDIR while reading packages/cli/package.json"))
      .toBeNull();
    expect(classifyTransientMergeError("User noted ENOENT in a comment, but no process was spawned"))
      .toBeNull();
    expect(classifyTransientMergeError("Verification failed: cannot find module './missing-file.js'"))
      .toBeNull();
  });

  it("keeps existing transient merge classes stable", () => {
    expect(classifyTransientMergeError("Merge handoff refused (lease-handoff-failed): target-not-queued"))
      .toBe("lease-handoff-target-not-queued");

    expect(classifyTransientMergeError(
      "Integration branch main advanced concurrently (expected 5b5da2c24fa006b46139ce4566b764126c6b84ca, observed 5b5da2c24fa006b46139ce4566b764126c6b84ca) while applying 283b290aec527f9ba4244f2935700a2823dd106b",
    )).toBe("spurious-concurrent-advance-same-sha");
  });

  it("does not classify genuine concurrent advances with different SHAs", () => {
    expect(classifyTransientMergeError(
      "Integration branch main advanced concurrently (expected aaa1111aaa1111aaa1111aaa1111aaa1111aaaa, observed bbb2222bbb2222bbb2222bbb2222bbb2222bbbb) while applying ccc3333ccc3333ccc3333ccc3333ccc3333cccc",
    )).toBeNull();
  });
});
