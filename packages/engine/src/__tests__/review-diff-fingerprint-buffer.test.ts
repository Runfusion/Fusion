import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => {
  type Response = { stdout: string; stderr?: string } | { error: Error & { code?: string } };
  const state: { respond: (args: string[]) => Response } = {
    respond: () => ({ stdout: "" }),
  };
  const execFile = vi.fn((
    _file: string,
    args: string[],
    options: { maxBuffer?: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const response = state.respond(args);
    if ("error" in response) {
      callback(response.error, "", "");
      return;
    }
    const stdout = response.stdout;
    if (typeof options.maxBuffer === "number" && Buffer.byteLength(stdout) > options.maxBuffer) {
      const error = Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
      callback(error, "", "");
      return;
    }
    callback(null, stdout, response.stderr ?? "");
  });
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = (
    file: string,
    args: string[],
    options: { maxBuffer?: number },
  ) => new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
  return { execFile, state };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: childProcess.execFile,
}));

import {
  computeCodeReviewInputFingerprint,
  EMPTY_REVIEW_DIFF_FINGERPRINT,
  probeReviewChangesSinceCommit,
  probeReviewDiffFingerprint,
  REVIEW_DIFF_GIT_MAX_BUFFER_BYTES,
  REVIEW_DIFF_GIT_TIMEOUT_MS,
} from "../worktree/review-diff-fingerprint.js";

describe("review diff fingerprint bounded capture", () => {
  beforeEach(() => {
    childProcess.execFile.mockClear();
    childProcess.state.respond = () => ({ stdout: "" });
  });

  it("captures a two-megabyte binary diff and reuses its stable fingerprint", async () => {
    const diff = `diff --git a/large.bin b/large.bin\n${"x".repeat(2 * 1024 * 1024)}`;
    childProcess.state.respond = () => ({ stdout: diff });
    const expected = createHash("sha256").update(diff).digest("hex");

    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({
      state: "fingerprint",
      fingerprint: expected,
    });
    await expect(computeCodeReviewInputFingerprint("/worktree", "base")).resolves.toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(childProcess.execFile).toHaveBeenCalledWith(
      "git",
      ["diff", "--binary", "base..HEAD"],
      expect.objectContaining({
        maxBuffer: REVIEW_DIFF_GIT_MAX_BUFFER_BYTES,
        timeout: REVIEW_DIFF_GIT_TIMEOUT_MS,
      }),
      expect.any(Function),
    );
  });

  it("names a diff that exceeds the explicit ten-megabyte bound", async () => {
    childProcess.state.respond = () => ({ stdout: "x".repeat(REVIEW_DIFF_GIT_MAX_BUFFER_BYTES + 1) });
    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({
      state: "unavailable",
      reason: "git-diff-too-large",
    });
  });

  it("keeps arbitrary child-process failures distinct from overflow", async () => {
    childProcess.state.respond = () => ({ error: new Error("spawn failed") });
    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({
      state: "unavailable",
      reason: "git-diff-failed",
    });
  });

  it("preserves empty-input normalization", async () => {
    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({ state: "empty" });
    await expect(computeCodeReviewInputFingerprint("/worktree", "base")).resolves.toBe(EMPTY_REVIEW_DIFF_FINGERPRINT);
  });

  it("preserves frozen and changed probes under the bounded options", async () => {
    childProcess.state.respond = (args) => {
      if (args[0] === "rev-list") return { stdout: "0\n" };
      return { stdout: "" };
    };
    await expect(probeReviewChangesSinceCommit("/worktree", "reviewed")).resolves.toEqual({
      state: "frozen",
      commitCount: 0,
    });

    childProcess.state.respond = (args) => {
      if (args[0] === "rev-list") return { stdout: "2\n" };
      if (args.includes("--name-only")) return { stdout: "src/a.ts\0src/b.ts\0" };
      if (args.includes("--shortstat")) return { stdout: " 2 files changed, 3 insertions(+)\n" };
      return { stdout: "" };
    };
    await expect(probeReviewChangesSinceCommit("/worktree", "reviewed")).resolves.toEqual({
      state: "changed",
      commitCount: 2,
      changedFiles: ["src/a.ts", "src/b.ts"],
      totalChangedFileCount: 2,
      shortstat: "2 files changed, 3 insertions(+)",
    });
    expect(childProcess.execFile.mock.calls.every((call) => (
      (call[2] as { maxBuffer?: number }).maxBuffer === REVIEW_DIFF_GIT_MAX_BUFFER_BYTES
      && (call[2] as { timeout?: number }).timeout === REVIEW_DIFF_GIT_TIMEOUT_MS
    ))).toBe(true);
  });
});
