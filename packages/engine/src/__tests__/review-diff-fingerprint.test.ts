import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeCodeReviewInputFingerprint,
  EMPTY_REVIEW_DIFF_FINGERPRINT,
} from "../worktree/review-diff-fingerprint.js";

describe("computeCodeReviewInputFingerprint", () => {
  it("distinguishes empty, populated, and unavailable Git evidence", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-empty-review-fingerprint-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test User");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", "file.txt");
      git("commit", "-m", "base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(repo, "file.txt"), "changed\n");
      git("commit", "-am", "change");

      await expect(computeCodeReviewInputFingerprint(repo, "HEAD"))
        .resolves.toBe(EMPTY_REVIEW_DIFF_FINGERPRINT);
      await expect(computeCodeReviewInputFingerprint(repo, base))
        .resolves.toMatch(/^[0-9a-f]{64}$/);
      await expect(computeCodeReviewInputFingerprint("/path/that/does/not/exist", "HEAD"))
        .resolves.toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
