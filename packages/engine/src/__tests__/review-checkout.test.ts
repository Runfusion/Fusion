/*
FNXC:ReviewRouting 2026-07-01-16:36:
External review checkout contract tests pin fail-closed resolution: absent, blank, relative, or non-git metadata resolves to the task worktree fallback; valid explicit absolute git checkouts resolve to their realpath; sourceMetadata.externalReviewCheckout is the canonical external field; invalid higher-priority metadata must not silently widen to lower-priority metadata.
*/
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReviewCheckoutCwd, getTaskReviewCheckoutPath } from "../execution/review-checkout.js";

const FALLBACK = "/some/fallback/worktree";
const cleanupDirs: string[] = [];

function makeGitCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-git-checkout-"));
  cleanupDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeNonGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-nongit-"));
  cleanupDirs.push(dir);
  return dir;
}

function makeRegularFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-file-"));
  cleanupDirs.push(dir);
  const file = join(dir, "file.txt");
  writeFileSync(file, "not a directory");
  return file;
}

beforeEach(() => {
  cleanupDirs.length = 0;
});
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("getTaskReviewCheckoutPath — extracts metadata path candidates", () => {
  it("returns undefined for null/undefined task", () => {
    expect(getTaskReviewCheckoutPath(null)).toBeUndefined();
    expect(getTaskReviewCheckoutPath(undefined)).toBeUndefined();
  });

  it("returns undefined when no metadata fields are present", () => {
    expect(getTaskReviewCheckoutPath({})).toBeUndefined();
    expect(getTaskReviewCheckoutPath({ id: "TASK-1", title: "T" })).toBeUndefined();
  });

  it("returns undefined for blank/whitespace-only reviewCheckoutPath", () => {
    expect(getTaskReviewCheckoutPath({ customFields: { reviewCheckoutPath: "" } })).toBeUndefined();
    expect(getTaskReviewCheckoutPath({ customFields: { reviewCheckoutPath: "   " } })).toBeUndefined();
    expect(getTaskReviewCheckoutPath({ customFields: { externalReviewCheckoutPath: "" } })).toBeUndefined();
  });

  it("returns undefined for non-string reviewCheckoutPath", () => {
    expect(getTaskReviewCheckoutPath({ customFields: { reviewCheckoutPath: 42 } })).toBeUndefined();
    expect(getTaskReviewCheckoutPath({ customFields: { reviewCheckoutPath: true } })).toBeUndefined();
    expect(getTaskReviewCheckoutPath({ customFields: { reviewCheckoutPath: {} } })).toBeUndefined();
  });

  it("reads reviewCheckoutPath from customFields", () => {
    const task = { customFields: { reviewCheckoutPath: "/custom/path" } };
    expect(getTaskReviewCheckoutPath(task)).toBe("/custom/path");
  });

  it("reads externalReviewCheckoutPath from customFields", () => {
    const task = { customFields: { externalReviewCheckoutPath: "/external/path" } };
    expect(getTaskReviewCheckoutPath(task)).toBe("/external/path");
  });

  it("reads nested reviewCheckout.path from customFields", () => {
    const task = { customFields: { reviewCheckout: { path: "/nested/path" } } };
    expect(getTaskReviewCheckoutPath(task)).toBe("/nested/path");
  });

  it("reads sourceMetadata.externalReviewCheckout as a candidate", () => {
    const task = { sourceMetadata: { externalReviewCheckout: "/meta/checkout" } };
    expect(getTaskReviewCheckoutPath(task)).toBe("/meta/checkout");
  });

  it("trims whitespace from metadata values", () => {
    const task = { customFields: { reviewCheckoutPath: "  /trimmed/path  " } };
    expect(getTaskReviewCheckoutPath(task)).toBe("/trimmed/path");
  });

  it("customFields takes priority over branchContext, sourceMetadata, and root", () => {
    const task = {
      customFields: { reviewCheckoutPath: "/custom" },
      branchContext: { reviewCheckoutPath: "/branch" },
      sourceMetadata: { externalReviewCheckout: "/meta" },
      reviewCheckoutPath: "/root",
    };
    expect(getTaskReviewCheckoutPath(task)).toBe("/custom");
  });

  it("branchContext takes priority over sourceMetadata and root-level fields", () => {
    const task = {
      branchContext: { reviewCheckoutPath: "/branch" },
      sourceMetadata: { externalReviewCheckout: "/meta" },
      reviewCheckoutPath: "/root",
    };
    expect(getTaskReviewCheckoutPath(task)).toBe("/branch");
  });

  it("sourceMetadata takes priority over root-level fields", () => {
    const task = {
      sourceMetadata: { externalReviewCheckout: "/meta" },
      reviewCheckoutPath: "/root",
    };
    expect(getTaskReviewCheckoutPath(task)).toBe("/meta");
  });
});

describe("resolveReviewCheckoutCwd — fail-closed defaults", () => {
  it("returns fallback when task has no metadata", () => {
    expect(resolveReviewCheckoutCwd({}, FALLBACK)).toBe(FALLBACK);
  });

  it("returns fallback for null/undefined task", () => {
    expect(resolveReviewCheckoutCwd(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveReviewCheckoutCwd(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it("returns fallback when reviewCheckoutPath is blank", () => {
    const task = { customFields: { reviewCheckoutPath: "" } };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });

  it("returns fallback for relative path (not absolute)", () => {
    const task = { customFields: { reviewCheckoutPath: "relative/path" } };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });

  it("returns fallback for non-existent path", () => {
    const task = { customFields: { reviewCheckoutPath: "/nonexistent/path/that/does/not/exist" } };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });

  it("returns fallback for path that is a regular file, not a directory", () => {
    const file = makeRegularFile();
    const task = { customFields: { reviewCheckoutPath: file } };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });

  it("returns fallback for non-git directory", () => {
    const dir = makeNonGitDir();
    const task = { customFields: { reviewCheckoutPath: dir } };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });

  it("returns resolved realpath for valid git checkout", () => {
    const checkout = makeGitCheckout();
    const expected = realpathSync(checkout);
    const task = { customFields: { reviewCheckoutPath: checkout } };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(expected);
  });

  it("resolves sourceMetadata.externalReviewCheckout for valid git checkout", () => {
    const checkout = makeGitCheckout();
    const expected = realpathSync(checkout);
    const task = { sourceMetadata: { externalReviewCheckout: checkout } };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(expected);
  });

  it("does not infer external checkout from prompt text or task description", () => {
    const task = {
      description: "Please review changes in /tmp/external-runtime",
      prompt: "Look at /tmp/some-checkout",
    };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });

  it("conflicting metadata between customFields and sourceMetadata: customFields wins when valid", () => {
    const checkoutA = makeGitCheckout();
    const checkoutB = makeGitCheckout();
    const expectedA = realpathSync(checkoutA);
    const task = {
      customFields: { reviewCheckoutPath: checkoutA },
      sourceMetadata: { externalReviewCheckout: checkoutB },
    };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(expectedA);
  });

  it("valid customFields + invalid sourceMetadata: uses customFields", () => {
    const checkout = makeGitCheckout();
    const expected = realpathSync(checkout);
    const task = {
      customFields: { reviewCheckoutPath: checkout },
      sourceMetadata: { externalReviewCheckout: "/nonexistent" },
    };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(expected);
  });

  // Priority-based resolution means the first candidate from the highest-priority
  // source (customFields > branchContext > sourceMetadata > root) is the only
  // candidate validated. When that candidate is invalid, the resolver fails
  // closed to the fallback instead of trying lower-priority sources. That keeps a
  // stale high-priority value from being bypassed by a coincidentally valid lower
  // priority path.
  it("invalid customFields → falls back even when sourceMetadata has a valid checkout (fail-closed priority)", () => {
    const checkout = makeGitCheckout();
    const task = {
      customFields: { reviewCheckoutPath: "/nonexistent" },
      sourceMetadata: { externalReviewCheckout: checkout },
    };
    // customFields wins priority; /nonexistent fails validation → fallback
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });

  it("workspace-mode task without explicit metadata: returns fallback (task worktree)", () => {
    const task = {
      workspaceWorktrees: {
        "repo-a": { worktreePath: "/tmp/ws/repo-a/.worktrees/task-1" },
      },
    };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });
});

describe("resolveReviewCheckoutCwd — does NOT fabricate approval or widen scope", () => {
  it("metadata pointing to a parent directory of the fallback: still validates as git dir", () => {
    const parent = makeGitCheckout();
    const task = { customFields: { reviewCheckoutPath: parent } };
    const result = resolveReviewCheckoutCwd(task, FALLBACK);
    expect(result).toBe(realpathSync(parent));
    expect(result).not.toBe(FALLBACK);
  });

  it("empty sourceMetadata object: returns fallback", () => {
    const task = { sourceMetadata: {} };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });

  it("sourceMetadata with unrelated fields only: returns fallback", () => {
    const task = { sourceMetadata: { fileScope: ["src/**"], contentFingerprint: "abc" } };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });

  it("blank sourceMetadata.externalReviewCheckout: returns fallback", () => {
    const task = { sourceMetadata: { externalReviewCheckout: "" } };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });

  it("non-string sourceMetadata.externalReviewCheckout: returns fallback", () => {
    const task = { sourceMetadata: { externalReviewCheckout: 42 } };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });

  it("relative sourceMetadata.externalReviewCheckout: returns fallback", () => {
    const task = { sourceMetadata: { externalReviewCheckout: "relative/path" } };
    expect(resolveReviewCheckoutCwd(task, FALLBACK)).toBe(FALLBACK);
  });
});
