import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
FNXC:ReviewInputProof 2026-11-02-15:52 (RUFU-445):
The binary patch is hashed from a STREAM, so this harness fakes `spawn` (chunk emission + kill) and
keeps the `execFile` mock only for the small metadata probes, which still run under the bounded
`execFile` options on purpose. Every case states the split it pins: stable digest, streamed overflow
by byte COUNT (a `maxBuffer` child-process error is now structurally impossible for the patch),
spawn failure, timeout kill, and the FN-180 empty-vs-unreadable split.
*/
const childProcess = vi.hoisted(() => {
  type MetadataResponse = { stdout: string; stderr?: string } | { error: Error & { code?: string } };
  type SpawnResponse = {
    chunks?: (string | Buffer)[];
    exitCode?: number;
    spawnError?: Error & { code?: string };
    /** Never close the child — models a git that hangs until the timeout kills it. */
    hang?: boolean;
  };
  const state: {
    respond: (args: string[]) => MetadataResponse;
    spawnRespond: (args: string[]) => SpawnResponse;
    spawnCalls: Array<{ file: string; args: string[]; options: unknown }>;
    killed: number;
    lastChild: EventEmitter & { kill: () => void };
  } = {
    respond: () => ({ stdout: "" }),
    spawnRespond: () => ({ chunks: [], exitCode: 0 }),
    spawnCalls: [],
    killed: 0,
    lastChild: null as never,
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

  const spawn = vi.fn((file: string, args: string[], options: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.kill = vi.fn(() => {
      state.killed += 1;
    });
    state.spawnCalls.push({ file, args, options });
    state.lastChild = child;
    if (!state.spawnRespond(args).hang) {
      queueMicrotask(() => {
        const response = state.spawnRespond(args);
        for (const chunk of response.chunks ?? []) {
          child.stdout.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (response.spawnError) {
          child.emit("error", response.spawnError);
          return;
        }
        child.emit("close", response.exitCode ?? 0);
      });
    }
    return child;
  });

  return { execFile, spawn, state };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: childProcess.execFile,
  spawn: childProcess.spawn,
}));

import {
  computeCodeReviewInputFingerprint,
  EMPTY_REVIEW_DIFF_FINGERPRINT,
  probeReviewChangesSinceCommit,
  probeReviewDiffFingerprint,
  REVIEW_DIFF_GIT_MAX_BUFFER_BYTES,
  REVIEW_DIFF_GIT_TIMEOUT_MS,
} from "../worktree/review-diff-fingerprint.js";

beforeEach(() => {
  childProcess.execFile.mockClear();
  childProcess.spawn.mockClear();
  childProcess.state.respond = () => ({ stdout: "" });
  childProcess.state.spawnRespond = () => ({ chunks: [], exitCode: 0 });
  childProcess.state.spawnCalls = [];
  childProcess.state.killed = 0;
});

describe("review diff fingerprint streamed capture", () => {
  it("hashes a two-megabyte binary diff from its stream and keeps the fingerprint stable", async () => {
    const diff = `diff --git a/large.bin b/large.bin\n${"x".repeat(2 * 1024 * 1024)}`;
    // Emitted in chunks, so a single buffered capture could not produce this digest.
    const chunks = [diff.slice(0, 700_000), diff.slice(700_000, 1_600_000), diff.slice(1_600_000)];
    childProcess.state.spawnRespond = () => ({ chunks, exitCode: 0 });
    const expected = createHash("sha256").update(diff).digest("hex");

    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({
      state: "fingerprint",
      fingerprint: expected,
    });
    await expect(computeCodeReviewInputFingerprint("/worktree", "base")).resolves.toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(childProcess.spawn).toHaveBeenCalledWith(
      "git",
      ["diff", "--binary", "base..HEAD"],
      expect.objectContaining({ cwd: "/worktree" }),
    );
  });

  it("keeps the streamed digest identical to the legacy buffered-utf8 digest for a round-trippable patch", async () => {
    /*
    FNXC:ReviewInputProof 2026-11-02-15:52 (RUFU-445): the fingerprint definition moved from hashing
    the utf8-DECODED stdout string to hashing raw bytes. This is the parity contract that makes that
    migration a no-op for ordinary patches (git's own base85 `GIT binary patch` blocks are ASCII, so
    they round-trip). Where utf8 decoding is lossy the digests may differ, and the only consequence
    is one extra "review input changed" convergence round.
    */
    const patch = `diff --git a/notes.md b/notes.md\n+riši zlty kvíp placeholder\n`;
    const legacy = createHash("sha256").update(Buffer.from(patch, "utf8").toString("utf8")).digest("hex");
    childProcess.state.spawnRespond = () => ({ chunks: [Buffer.from(patch, "utf8")], exitCode: 0 });
    const streamed = await probeReviewDiffFingerprint("/worktree", "base");
    expect(streamed).toEqual({ state: "fingerprint", fingerprint: legacy });
  });

  it("passes the target ref through so a workspace branch is not read as an empty checkout", async () => {
    childProcess.state.spawnRespond = () => ({ chunks: ["diff --git a/x b/x\n"], exitCode: 0 });
    await probeReviewDiffFingerprint("/worktree", "base", "fusion/task-branch");
    expect(childProcess.state.spawnCalls[0]?.args).toEqual(["diff", "--binary", "base..fusion/task-branch"]);
  });

  it("hashes a nine-megabyte patch incrementally, far past the old one-megabyte child-process default", async () => {
    const chunk = "x".repeat(1024 * 1024);
    const chunks = Array.from({ length: 9 }, (_, index) => `${index}`.repeat(1) + chunk.slice(1));
    childProcess.state.spawnRespond = () => ({ chunks, exitCode: 0 });
    const expected = chunks.reduce((hash, part) => hash.update(Buffer.from(part)), createHash("sha256")).digest("hex");

    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({
      state: "fingerprint",
      fingerprint: expected,
    });
    // Nine megabytes streamed, so the digest demonstrably came from chunk-by-chunk hashing.
    expect(childProcess.state.spawnCalls[0]?.options).not.toHaveProperty("maxBuffer");
  });

  it("refuses by streamed byte count past the ten-megabyte bound and kills the child", async () => {
    // Twelve one-megabyte chunks: no single chunk is over the bound, only the accumulated total is,
    // so the refusal must come from the byte counter and not from a child-process buffer error.
    const chunk = "x".repeat(1024 * 1024);
    childProcess.state.spawnRespond = () => ({ chunks: Array.from({ length: 12 }, () => chunk), exitCode: 0 });
    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({
      state: "unavailable",
      reason: "git-diff-too-large",
    });
    expect(childProcess.state.killed).toBeGreaterThan(0);
    expect(childProcess.spawn.mock.calls[0]?.[2]).not.toHaveProperty("maxBuffer");
  });

  it("classifies a spawn failure and a non-zero git exit as an unreadable input, never as empty", async () => {
    childProcess.state.spawnRespond = () => ({ chunks: [], spawnError: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }) });
    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({
      state: "unavailable",
      reason: "git-diff-failed",
    });

    childProcess.state.spawnRespond = () => ({ chunks: ["partial\n"], exitCode: 128 });
    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({
      state: "unavailable",
      reason: "git-diff-failed",
    });
  });

  it("kills and refuses a hanging diff at the review git timeout", async () => {
    vi.useFakeTimers();
    try {
      childProcess.state.spawnRespond = () => ({ chunks: ["diff --git a/x b/x\n"], hang: true });
      const pending = probeReviewDiffFingerprint("/worktree", "base");
      vi.advanceTimersByTime(REVIEW_DIFF_GIT_TIMEOUT_MS + 1);
      await expect(pending).resolves.toEqual({ state: "unavailable", reason: "git-diff-failed" });
      expect(childProcess.state.killed).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves empty-input normalization", async () => {
    childProcess.state.spawnRespond = () => ({ chunks: [], exitCode: 0 });
    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({ state: "empty" });
    await expect(computeCodeReviewInputFingerprint("/worktree", "base")).resolves.toBe(EMPTY_REVIEW_DIFF_FINGERPRINT);
  });

  it("reports a missing worktree or base without spawning anything", async () => {
    await expect(probeReviewDiffFingerprint(undefined, "base")).resolves.toEqual({
      state: "unavailable",
      reason: "missing-worktree-or-base",
    });
    await expect(probeReviewDiffFingerprint("/worktree", undefined)).resolves.toEqual({
      state: "unavailable",
      reason: "missing-worktree-or-base",
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
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
    // The SMALL metadata probes keep the bounded execFile options; only the patch itself streams.
    expect(childProcess.execFile.mock.calls.every((call) => (
      (call[2] as { maxBuffer?: number }).maxBuffer === REVIEW_DIFF_GIT_MAX_BUFFER_BYTES
      && (call[2] as { timeout?: number }).timeout === REVIEW_DIFF_GIT_TIMEOUT_MS
    ))).toBe(true);
    expect(childProcess.execFile.mock.calls.some((call) => call[1]?.[0] === "cat-file")).toBe(true);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("keeps the small metadata probes failing closed when git refuses them", async () => {
    childProcess.state.respond = () => ({ error: new Error("not a repository") });
    await expect(probeReviewChangesSinceCommit("/worktree", "reviewed")).resolves.toEqual({
      state: "unavailable",
      reason: "git-changes-since-review-failed",
    });
  });
});
