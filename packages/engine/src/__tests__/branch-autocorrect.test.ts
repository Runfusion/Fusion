import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecException } from "node:child_process";

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execMock = vi.fn();

  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    Promise.resolve()
      .then(() => execMock(cmd, typeof opts === "function" ? {} : (opts ?? {})))
      .then((result) => callback?.(null, result?.stdout ?? "", result?.stderr ?? ""))
      .catch((err) => {
        const e = err as ExecException & { stdout?: string; stderr?: string };
        callback?.(err, e.stdout ?? "", e.stderr ?? "");
      });
  });

  execFn[promisify.custom] = (cmd: string, opts?: any) =>
    new Promise((resolve, reject) => {
      execFn(cmd, opts, (err: any, stdout: string, stderr: string) => {
        if (err) {
          (err as Record<string, unknown>).stdout = stdout;
          (err as Record<string, unknown>).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });

  return { exec: execFn, __execMock: execMock };
});

import { attemptBranchAutocorrect } from "../branch-autocorrect.js";
import { __execMock as execMock } from "node:child_process";

const mockedExec = vi.mocked(execMock);

function execError(stderr: string): Error & { stderr: string } {
  const error = new Error("exec failed") as Error & { stderr: string };
  error.stderr = stderr;
  return error;
}

describe("attemptBranchAutocorrect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { observed: "", expected: "fusion/fn-1" },
    { observed: "fusion/fn-1", expected: "" },
    { observed: "fusion/fn-1", expected: "fusion/fn-1" },
  ])("returns invalid-input for bad branch names %#", async ({ observed, expected }) => {
    const result = await attemptBranchAutocorrect({ worktreePath: "/tmp/wt", observedBranch: observed, expectedBranch: expected, rootDir: "/tmp" });
    expect(result).toEqual({ status: "failed", reason: "invalid-input" });
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("renames fresh branch", async () => {
    mockedExec
      .mockResolvedValueOnce({ stdout: "" }) // upstream check fails via rejection below, so first call should reject
      .mockRejectedValueOnce(execError("no upstream"));
    mockedExec.mockReset();
    mockedExec
      .mockRejectedValueOnce(execError("no upstream"))
      .mockResolvedValueOnce({ stdout: "abc123\n" })
      .mockResolvedValueOnce({ stdout: "lemon-sage\n" })
      .mockResolvedValueOnce({ stdout: "" });

    const result = await attemptBranchAutocorrect({ worktreePath: "/tmp/wt", observedBranch: "lemon-sage", expectedBranch: "fusion/fn-2", rootDir: "/tmp" });

    expect(result).toEqual({ status: "renamed" });
    expect(mockedExec.mock.calls.map((c) => c[0])).toContain("git branch -m 'lemon-sage' 'fusion/fn-2'");
  });

  it("falls back to checkout -B when branch has upstream", async () => {
    mockedExec
      .mockResolvedValueOnce({ stdout: "origin/lemon-sage\n" })
      .mockResolvedValueOnce({ stdout: "" });

    const result = await attemptBranchAutocorrect({ worktreePath: "/tmp/wt", observedBranch: "lemon-sage", expectedBranch: "fusion/fn-2", rootDir: "/tmp" });
    expect(result).toEqual({ status: "checked-out" });
    expect(mockedExec.mock.calls.map((c) => c[0])).toEqual([
      "git rev-parse --abbrev-ref --symbolic-full-name 'lemon-sage'@{u}",
      "git checkout -B 'fusion/fn-2'",
    ]);
  });

  it("falls back to checkout -B when branch sha is shared", async () => {
    mockedExec
      .mockRejectedValueOnce(execError("no upstream"))
      .mockResolvedValueOnce({ stdout: "abc123\n" })
      .mockResolvedValueOnce({ stdout: "lemon-sage\nmain\n" })
      .mockResolvedValueOnce({ stdout: "" });

    const result = await attemptBranchAutocorrect({ worktreePath: "/tmp/wt", observedBranch: "lemon-sage", expectedBranch: "fusion/fn-2", rootDir: "/tmp" });
    expect(result).toEqual({ status: "checked-out" });
  });

  it("falls back to checkout -B when rename fails", async () => {
    mockedExec
      .mockRejectedValueOnce(execError("no upstream"))
      .mockResolvedValueOnce({ stdout: "abc123\n" })
      .mockResolvedValueOnce({ stdout: "lemon-sage\n" })
      .mockRejectedValueOnce(execError("rename denied"))
      .mockResolvedValueOnce({ stdout: "" });

    const result = await attemptBranchAutocorrect({ worktreePath: "/tmp/wt", observedBranch: "lemon-sage", expectedBranch: "fusion/fn-2", rootDir: "/tmp" });
    expect(result).toEqual({ status: "checked-out" });
  });

  it("returns failed when rename and checkout both fail", async () => {
    mockedExec
      .mockRejectedValueOnce(execError("no upstream"))
      .mockResolvedValueOnce({ stdout: "abc123\n" })
      .mockResolvedValueOnce({ stdout: "lemon-sage\n" })
      .mockRejectedValueOnce(execError("rename denied"))
      .mockRejectedValueOnce(execError("checkout denied"));

    const result = await attemptBranchAutocorrect({ worktreePath: "/tmp/wt", observedBranch: "lemon-sage", expectedBranch: "fusion/fn-2", rootDir: "/tmp" });
    expect(result).toEqual({ status: "failed", reason: "checkout denied" });
  });
});
