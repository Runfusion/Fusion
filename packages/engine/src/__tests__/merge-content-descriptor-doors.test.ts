import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

const checkout = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("../worktree/review-checkout-clean.js", () => ({ probeReviewCheckout: checkout.probe }));

const childProcess = vi.hoisted(() => {
  const diff = `diff --git a/large.bin b/large.bin\n${"x".repeat(2 * 1024 * 1024)}`;
  /*
  FNXC:ReviewInputProof 2026-11-02-15:52 (RUFU-445):
  The binary patch is hashed from a STREAM now, so this harness fakes `spawn` as well as `execFile`
  and emits the same two-megabyte patch in chunks. The assertion is unchanged — the merge door must
  capture the same fingerprint — only the seam it arrives through moved. `execFile` stays mocked for
  the small metadata probes, which remain bounded `execFile` calls on purpose.
  */
  const makeEmitter = () => {
    const listeners = new Map<string, Array<(arg?: unknown) => void>>();
    return {
      on: (event: string, cb: (arg?: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), cb]);
      },
      emit: (event: string, arg?: unknown) => {
        for (const cb of listeners.get(event) ?? []) cb(arg);
      },
    };
  };
  const spawn = vi.fn((_file: string, args: string[]) => {
    const stdout = makeEmitter();
    const child = { ...makeEmitter(), stdout, kill: vi.fn() };
    queueMicrotask(() => {
      if (String(args[0] ?? "") === "diff") {
        stdout.emit("data", Buffer.from(diff.slice(0, 700_000)));
        stdout.emit("data", Buffer.from(diff.slice(700_000)));
      }
      child.emit("close", 0);
    });
    return child;
  });
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
  return { diff, execFile, spawn };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: childProcess.execFile,
  spawn: childProcess.spawn,
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
  beforeEach(() => checkout.probe.mockReset().mockResolvedValue({ state: "clean" }));

  it.each(["dirty", "unavailable"])("refuses singular merge content when the reviewed checkout is %s", async (state) => {
    checkout.probe.mockResolvedValue({ state, paths: ["src/fix.ts"] });
    const descriptor = await captureMergeContentDescriptor({ id: "FN-9442", worktree: "/worktree" } as Task, {
      workspaceRootDir: process.cwd(), settings: {},
    });
    expect(descriptor).toMatchObject({ kind: "singular", diff: { state: "unavailable" } });
    expect(checkout.probe).toHaveBeenCalledWith("/worktree");
  });

  it("refuses workspace merge content if any repository has uncommitted review fixes", async () => {
    checkout.probe.mockResolvedValue({ state: "dirty", paths: ["src/fix.ts"] });
    const descriptor = await captureMergeContentDescriptor({
      id: "FN-9442", executionMode: "workspace",
      workspaceWorktrees: { api: { worktreePath: "/api", branch: "fusion/task" } },
    } as unknown as Task, { workspaceRootDir: process.cwd(), settings: {} });
    expect(descriptor).toMatchObject({ kind: "workspace", repositories: { state: "unavailable" } });
    expect(checkout.probe).toHaveBeenCalledWith("/api");
  });
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
    /*
    FNXC:TestAssertions 2026-10-03-01:12 (RUFU-519): this used to pin the whole statement
    `state: "unavailable", reason: "workspace-evidence-capture-failed"`, so any change to that line's
    SHAPE failed the test even when behavior was identical. RUFU-519 adds a second, named reason for a
    member whose worktree is gone, which necessarily reflows the statement. The construct worth guarding
    is that an unavailable workspace capture always carries a reason constant; the actual reason values
    and their behavior are asserted in `workspace-member-evidence.test.ts` against real git fixtures.
    */
    expect(source).toContain("workspace-evidence-capture-failed");
    expect(source).toContain("WorkspaceMemberEvidenceError");
    expect(source).not.toContain("reviewInputFingerprint");
  });
});
