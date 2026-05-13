import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecException } from "node:child_process";

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execSyncFn = vi.fn();

  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "function" ? {} : (opts ?? {});
    try {
      const out = execSyncFn(cmd, { ...options, stdio: ["pipe", "pipe", "pipe"] });
      const stdout = out === undefined ? "" : out.toString();
      if (typeof callback === "function") callback(null, stdout, "");
    } catch (err) {
      if (typeof callback === "function") {
        const error = err as ExecException & { stdout?: string; stderr?: string };
        callback(err, error?.stdout?.toString?.() ?? "", error?.stderr?.toString?.() ?? "");
      }
    }
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

  return { exec: execFn, execSync: execSyncFn };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { inspectBranchConflict, listBranchRecoveryCandidates, BranchConflictError } from "../branch-conflicts.js";

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);

describe("branch-conflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("classifies missing conflicting worktrees as stale", async () => {
    mockedExistsSync.mockImplementation((value) => value !== "/tmp/missing-wt");

    const result = await inspectBranchConflict({
      repoDir: "/tmp/repo",
      branchName: "fusion/fn-4068",
      conflictingWorktreePath: "/tmp/missing-wt",
      startPoint: "main",
    });

    expect(result).toEqual({ kind: "stale" });
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("returns a typed live conflict with stranded commits", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git rev-parse --verify 'fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-4068'")) {
        return Buffer.from("aaa111\tPreserve prior fix\nbbb222\tAdd regression coverage\n");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await inspectBranchConflict({
      repoDir: "/tmp/repo",
      branchName: "fusion/fn-4068",
      conflictingWorktreePath: "/tmp/existing-wt",
      startPoint: "main",
    });

    expect(result.kind).toBe("live");
    if (result.kind !== "live") {
      throw new Error("expected live conflict");
    }
    expect(result.error).toBeInstanceOf(BranchConflictError);
    expect(result.error).toMatchObject({
      branchName: "fusion/fn-4068",
      conflictingWorktreePath: "/tmp/existing-wt",
      existingTipSha: "abc123def456",
      startPoint: "main",
    });
    expect(result.error.strandedCommits).toEqual([
      { sha: "aaa111", subject: "Preserve prior fix" },
      { sha: "bbb222", subject: "Add regression coverage" },
    ]);
    expect(result.error.message).toContain("2 stranded commits since main");
  });

  it("lists canonical and sibling recovery candidates with worktrees and stranded commits", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git for-each-ref --format='%(refname:short)' refs/heads/fusion/fn-4068 refs/heads/fusion/fn-4068-*") {
        return Buffer.from("fusion/fn-4068\nfusion/fn-4068-2\n");
      }
      if (command === "git worktree list --porcelain") {
        return Buffer.from([
          "worktree /tmp/repo",
          "HEAD 1111111",
          "branch refs/heads/main",
          "",
          "worktree /tmp/fn-4068",
          "HEAD 2222222",
          "branch refs/heads/fusion/fn-4068",
          "",
          "worktree /tmp/fn-4068-2",
          "HEAD 3333333",
          "branch refs/heads/fusion/fn-4068-2",
          "",
        ].join("\n"));
      }
      if (command.includes("git rev-parse --verify 'fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123\n");
      }
      if (command.includes("git rev-parse --verify 'fusion/fn-4068-2^{commit}'")) {
        return Buffer.from("def456\n");
      }
      if (command.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-4068'")) {
        return Buffer.from("aaa111\tCanonical fix\n");
      }
      if (command.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-4068-2'")) {
        return Buffer.from("bbb222\tSibling patch\nccc333\tMore work\n");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await listBranchRecoveryCandidates({
      repoDir: "/tmp/repo",
      branchName: "fusion/fn-4068",
      startPoint: "main",
    });

    expect(result).toEqual([
      {
        branchName: "fusion/fn-4068",
        tipSha: "abc123",
        worktreePath: "/tmp/fn-4068",
        strandedCommits: [{ sha: "aaa111", subject: "Canonical fix" }],
        isCanonical: true,
      },
      {
        branchName: "fusion/fn-4068-2",
        tipSha: "def456",
        worktreePath: "/tmp/fn-4068-2",
        strandedCommits: [
          { sha: "bbb222", subject: "Sibling patch" },
          { sha: "ccc333", subject: "More work" },
        ],
        isCanonical: false,
      },
    ]);
  });
});
