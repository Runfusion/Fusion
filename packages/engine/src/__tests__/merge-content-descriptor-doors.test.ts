import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

const childProcess = vi.hoisted(() => {
  const diff = `diff --git a/large.bin b/large.bin\n${"x".repeat(2 * 1024 * 1024)}`;
  const execFile = vi.fn((
    _file: string,
    _args: string[],
    options: { maxBuffer?: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (typeof options.maxBuffer === "number" && Buffer.byteLength(diff) > options.maxBuffer) {
      callback(Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }), "", "");
      return;
    }
    callback(null, diff, "");
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
  return { diff, execFile };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: childProcess.execFile,
}));
vi.mock("../executor/worktree-git-refs.js", () => ({ resolveDiffBaseRef: vi.fn(async () => "base") }));

import { captureMergeContentDescriptor } from "../merge/merge-content-capture.js";

/*
 * FNXC:MergeContentDescriptorDoors 2026-08-23-09:15:
 * FN-180 requires merge doors to distinguish an empty patch from unavailable Git proof. The
 * capture seam is deliberately fail-closed: unavailable evidence is a descriptor the positive
 * gate can defer, never an implicit approval.
 */
describe("FN-180 merge content descriptor doors", () => {
  it("returns an unavailable singular descriptor when the door cannot establish a diff base", async () => {
    const descriptor = await captureMergeContentDescriptor({ id: "FN-180", column: "in-review" } as Task, {
      workspaceRootDir: process.cwd(), settings: {},
    });
    expect(descriptor).toEqual({ kind: "singular", diff: { state: "unavailable", reason: "missing-worktree-or-base" } });
  });

  it("captures the same two-megabyte singular fingerprint at the merge door", async () => {
    const descriptor = await captureMergeContentDescriptor({
      id: "FN-279",
      column: "in-review",
      worktree: "/worktree",
    } as Task, {
      workspaceRootDir: process.cwd(), settings: {},
    });
    expect(descriptor).toEqual({
      kind: "singular",
      diff: {
        state: "fingerprint",
        fingerprint: createHash("sha256").update(childProcess.diff).digest("hex"),
      },
    });
  });

  it("keeps workspace evidence capture separate from the scalar singular descriptor", async () => {
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../merge/merge-content-capture.ts", import.meta.url), "utf8",
    );
    expect(source).toContain("captureWorkspaceReviewEvidence");
    expect(source).toContain('state: "unavailable", reason: "workspace-evidence-capture-failed"');
    expect(source).not.toContain("reviewInputFingerprint");
  });
});
