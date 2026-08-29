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

  const execFileFn: any = vi.fn((file: string, args: string[] | undefined, opts: any, cb: any) =>
    execFn([file, ...(Array.isArray(args) ? args : [])].join(" "), opts, cb),
  );

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

  execFileFn[promisify.custom] = (file: string, args?: string[], opts?: any) =>
    execFn[promisify.custom]([file, ...(Array.isArray(args) ? args : [])].join(" "), opts);

  return { exec: execFn, execSync: execSyncFn, execFile: execFileFn };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  BranchConflictError,
  assertCleanBranchAtBase,
  inspectBranchConflict,
  listUniqueBranchCommits,
  reportBranchAttribution,
} from "../execution/branch-conflicts.js";

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
      requestingTaskId: "FN-4068",
      startPoint: "main",
    });

    expect(result).toEqual({ kind: "stale" });
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("FN-4397: treats branch as stale-resolved when conflicting path exists but branch is not checked out in any live worktree", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree prune") return Buffer.from("");
      if (command === "git worktree list --porcelain") {
        return Buffer.from(["worktree /tmp/repo", "HEAD 2222222", "branch refs/heads/main", ""].join("\n"));
      }
      if (command.includes("git rev-parse --verify 'refs/heads/fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git rev-parse --verify 'fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await inspectBranchConflict({
      repoDir: "/tmp/repo",
      branchName: "fusion/fn-4068",
      conflictingWorktreePath: "/tmp/stale-wt",
      requestingTaskId: "FN-4068",
      startPoint: "main",
    });

    expect(result).toEqual({ kind: "stale-resolved" });
  });

  it("prefers explicit integrationRef when inspecting branch conflicts", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree prune") return Buffer.from("");
      if (command === "git worktree list --porcelain") {
        return Buffer.from(["worktree /tmp/existing-wt", "HEAD 2222222", "branch refs/heads/fusion/fn-4068", ""].join("\n"));
      }
      if (command.includes("git rev-parse --verify 'refs/heads/fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git rev-parse --verify 'fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git rev-parse --verify 'master^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git merge-base 'master' 'fusion/fn-4068'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git merge-base --is-ancestor 'abc123def456' 'master'")) {
        return Buffer.from("");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await inspectBranchConflict({
      repoDir: "/tmp/repo",
      branchName: "fusion/fn-4068",
      conflictingWorktreePath: "/tmp/existing-wt",
      requestingTaskId: "FN-4068",
      startPoint: "master",
      integrationRef: "master",
    });

    expect(result).toMatchObject({ kind: "tip-already-merged", integrationRef: "master" });
  });

  it("FN-4476/FN-4471: classifies live branch at main tip as tip-already-merged even with stale-base churn", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree prune") return Buffer.from("");
      if (command === "git worktree list --porcelain") {
        return Buffer.from(["worktree /tmp/existing-wt", "HEAD 2222222", "branch refs/heads/fusion/fn-4068", ""].join("\n"));
      }
      if (command.includes("git rev-parse --verify 'refs/heads/fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git rev-parse --verify 'fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git rev-parse --verify 'main^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command === "git merge-base 'main' 'fusion/fn-4068'") {
        return Buffer.from("50ccd27a\n");
      }
      if (command === "git merge-base --is-ancestor 'abc123def456' 'main'") {
        return Buffer.from("");
      }
      if (command === "git cherry 'main' 'fusion/fn-4068' '50ccd27a'") {
        return Buffer.from("");
      }
      if (command.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-4068'")) {
        throw new Error("stale-base rev-list should not run when tip is already merged");
      }
      if (command.includes("git log --format=%H%x00%s%x00%b 'main..fusion/fn-4068'")) {
        return Buffer.from("");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await inspectBranchConflict({
      repoDir: "/tmp/repo",
      branchName: "fusion/fn-4068",
      conflictingWorktreePath: "/tmp/existing-wt",
      requestingTaskId: "FN-4068",
      startPoint: "main",
    });

    expect(result).toEqual({
      kind: "tip-already-merged",
      livePath: "/tmp/existing-wt",
      tipSha: "abc123def456",
      integrationRef: "main",
    });
  });

  it("returns fully-subsumed when git cherry reports no unique commits", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree prune") return Buffer.from("");
      if (command === "git worktree list --porcelain") {
        return Buffer.from(["worktree /tmp/existing-wt", "HEAD 2222222", "branch refs/heads/fusion/fn-4068", ""].join("\n"));
      }
      if (command.includes("git rev-parse --verify 'refs/heads/fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git rev-parse --verify 'fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git rev-parse --verify 'main^{commit}'")) {
        return Buffer.from("mainsha\n");
      }
      if (command === "git merge-base 'main' 'fusion/fn-4068'") {
        return Buffer.from("base123\n");
      }
      if (command === "git cherry 'main' 'fusion/fn-4068' 'base123'") {
        return Buffer.from("- abc111\n");
      }
      if (command.includes("git log --format=%H%x00%s%x00%b 'main..fusion/fn-4068'")) {
        return Buffer.from("");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await inspectBranchConflict({
      repoDir: "/tmp/repo",
      branchName: "fusion/fn-4068",
      conflictingWorktreePath: "/tmp/existing-wt",
      requestingTaskId: "FN-4068",
      startPoint: "main",
    });

    expect(result).toEqual({
      kind: "fully-subsumed",
      livePath: "/tmp/existing-wt",
      tipSha: "abc123def456",
    });
  });

  it("returns reclaimable for same-task live conflicts with stranded commits", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree prune") return Buffer.from("");
      if (command === "git worktree list --porcelain") {
        return Buffer.from(["worktree /tmp/existing-wt", "HEAD 2222222", "branch refs/heads/fusion/fn-4068", ""].join("\n"));
      }
      if (command.includes("git rev-parse --verify 'refs/heads/fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git rev-parse --verify 'fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git rev-parse --verify 'main^{commit}'")) {
        return Buffer.from("mainsha\n");
      }
      if (command === "git merge-base 'main' 'fusion/fn-4068'") {
        return Buffer.from("base123\n");
      }
      if (command === "git cherry 'main' 'fusion/fn-4068' 'base123'") {
        return Buffer.from("+ aaa111\n+ bbb222\n");
      }
      if (command.includes("git rev-parse --verify 'aaa111^{commit}'")) {
        return Buffer.from("aaa111\n");
      }
      if (command.includes("git rev-parse --verify 'bbb222^{commit}'")) {
        return Buffer.from("bbb222\n");
      }
      if (command === "git log -1 --format=%s 'aaa111'") {
        return Buffer.from("Preserve prior fix\n");
      }
      if (command === "git log -1 --format=%s 'bbb222'") {
        return Buffer.from("Add regression coverage\n");
      }
      if (command.includes("git log --format=%H%x00%s%x00%b 'main..fusion/fn-4068'")) {
        return Buffer.from("aaa111\u0000feat(FN-4068): preserve\u0000Fusion-Task-Id: FN-4068\u0000" +
          "bbb222\u0000fix(FN-4068): regression\u0000Fusion-Task-Id: FN-4068\u0000");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await inspectBranchConflict({
      repoDir: "/tmp/repo",
      branchName: "fusion/fn-4068",
      conflictingWorktreePath: "/tmp/existing-wt",
      requestingTaskId: "FN-4068",
      startPoint: "main",
    });

    expect(result.kind).toBe("reclaimable");
    if (result.kind !== "reclaimable") {
      throw new Error("expected reclaimable conflict");
    }
    expect(result).toMatchObject({
      livePath: "/tmp/existing-wt",
      tipSha: "abc123def456",
      taskAttributedCommitCount: 2,
    });
    expect(result.strandedCommits).toEqual([
      { sha: "aaa111", subject: "Preserve prior fix" },
      { sha: "bbb222", subject: "Add regression coverage" },
    ]);
  });

  it("returns live-foreign with BranchConflictError for cross-task collisions", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree prune") return Buffer.from("");
      if (command === "git worktree list --porcelain") {
        return Buffer.from(["worktree /tmp/existing-wt", "HEAD 2222222", "branch refs/heads/fusion/fn-4068", ""].join("\n"));
      }
      if (command.includes("git rev-parse --verify 'refs/heads/fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git rev-parse --verify 'fusion/fn-4068^{commit}'")) {
        return Buffer.from("abc123def456\n");
      }
      if (command.includes("git rev-parse --verify 'main^{commit}'")) {
        return Buffer.from("mainsha\n");
      }
      if (command === "git merge-base 'main' 'fusion/fn-4068'") {
        return Buffer.from("base123\n");
      }
      if (command === "git cherry 'main' 'fusion/fn-4068' 'base123'") {
        return Buffer.from("+ aaa111\n");
      }
      if (command.includes("git rev-parse --verify 'aaa111^{commit}'")) {
        return Buffer.from("aaa111\n");
      }
      if (command === "git log -1 --format=%s 'aaa111'") {
        return Buffer.from("Preserve prior fix\n");
      }
      if (command.includes("git log --format=%H%x00%s%x00%b 'main..fusion/fn-4068'")) {
        return Buffer.from("aaa111\u0000feat(FN-9999): foreign\u0000Fusion-Task-Id: FN-9999\u0000");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await inspectBranchConflict({
      repoDir: "/tmp/repo",
      branchName: "fusion/fn-4068",
      conflictingWorktreePath: "/tmp/existing-wt",
      requestingTaskId: "FN-4068",
      startPoint: "main",
    });

    expect(result.kind).toBe("live-foreign");
    if (result.kind !== "live-foreign") {
      throw new Error("expected live-foreign conflict");
    }
    expect(result.error).toBeInstanceOf(BranchConflictError);
    expect(result.error.message).toContain("1 stranded commit since main");
    expect(result.error.message).toContain("Inspect/reclaim or discard the conflicting local branch/worktree");
  });

  it("lists zero unique commits when git cherry has no plus entries", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git rev-parse --verify 'main^{commit}'")) {
        return Buffer.from("mainsha\n");
      }
      if (command === "git merge-base 'main' 'fusion/fn-4068'") {
        return Buffer.from("base123\n");
      }
      if (command === "git cherry 'main' 'fusion/fn-4068' 'base123'") {
        return Buffer.from("- abc111\n");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await listUniqueBranchCommits("/tmp/repo", "main", "fusion/fn-4068");

    expect(result).toEqual({ commits: [], mainRef: "main", degraded: false });
  });

  it("lists patch-id-unique commits from git cherry plus lines", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git rev-parse --verify 'main^{commit}'")) {
        return Buffer.from("mainsha\n");
      }
      if (command === "git merge-base 'main' 'fusion/fn-4068'") {
        return Buffer.from("base123\n");
      }
      if (command === "git cherry 'main' 'fusion/fn-4068' 'base123'") {
        return Buffer.from("+ abc111\n+ def222\n");
      }
      if (command.includes("git rev-parse --verify 'abc111^{commit}'")) {
        return Buffer.from("abc111full\n");
      }
      if (command.includes("git rev-parse --verify 'def222^{commit}'")) {
        return Buffer.from("def222full\n");
      }
      if (command === "git log -1 --format=%s 'abc111'") {
        return Buffer.from("First unique\n");
      }
      if (command === "git log -1 --format=%s 'def222'") {
        return Buffer.from("Second unique\n");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await listUniqueBranchCommits("/tmp/repo", "main", "fusion/fn-4068");

    expect(result).toEqual({
      commits: [
        { sha: "abc111full", subject: "First unique" },
        { sha: "def222full", subject: "Second unique" },
      ],
      mainRef: "main",
      degraded: false,
    });
  });

  it("falls back to rev-list stranded commits when git cherry fails", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git rev-parse --verify 'main^{commit}'")) {
        return Buffer.from("mainsha\n");
      }
      if (command === "git merge-base 'main' 'fusion/fn-4068'") {
        return Buffer.from("base123\n");
      }
      if (command === "git cherry 'main' 'fusion/fn-4068' 'base123'") {
        throw new Error("cherry failed");
      }
      if (command.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-4068'")) {
        return Buffer.from("aaa111\tFallback one\n");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await listUniqueBranchCommits("/tmp/repo", "main", "fusion/fn-4068");

    expect(result).toEqual({
      commits: [{ sha: "aaa111", subject: "Fallback one" }],
      mainRef: "main",
      degraded: true,
    });
  });

  it.each([
    {
      name: "passes when attribution comes from subject token",
    },
    {
      name: "passes when attribution comes from trailer token",
    },
    {
      name: "passes when commit is attributed to a foreign task",
    },
  ])("assertCleanBranchAtBase $name", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("assertCleanBranchAtBase should not inspect commit attribution");
    });

    await expect(assertCleanBranchAtBase("/tmp/repo", "fusion/fn-4068", "main", "FN-4068")).resolves.toBeUndefined();
  });

  describe("reportBranchAttribution", () => {
    const RS = "\x1e";
    const FS = "\x1f";

    function setupLog(records: { sha: string; subject: string; body: string }[]) {
      const log = records.map((r) => `${r.sha}${FS}${r.subject}${FS}${r.body}${RS}`).join("");
      mockedExecSync.mockImplementation((cmd: string | string[]) => {
        const command = typeof cmd === "string" ? cmd : cmd[0];
        if (command.includes("git log --format=%H%x1f%s%x1f%b%x1e")) {
          return Buffer.from(log);
        }
        throw new Error(`Unexpected command: ${command}`);
      });
    }

    it("counts own-trailed commits as healthy", async () => {
      setupLog([
        { sha: "aaa", subject: "feat(FN-1): add x", body: "Fusion-Task-Id: FN-1\n" },
        { sha: "bbb", subject: "fix(FN-1): tweak", body: "Fusion-Task-Id: FN-1\n" },
      ]);
      const r = await reportBranchAttribution("/tmp/repo", "fusion/fn-1", "main", "FN-1");
      expect(r.ownTrailed).toBe(2);
      expect(r.ownUntrailed).toEqual([]);
      expect(r.foreign).toEqual([]);
      expect(r.unattributed).toEqual([]);
    });

    it("flags FN-5233-class foreign commits", async () => {
      setupLog([
        { sha: "fff", subject: "feat(FN-5353): wire something", body: "" },
        { sha: "ggg", subject: "feat(FN-1): legit", body: "Fusion-Task-Id: FN-1\n" },
      ]);
      const r = await reportBranchAttribution("/tmp/repo", "fusion/fn-1", "main", "FN-1");
      expect(r.foreign).toEqual([{ sha: "fff", subject: "feat(FN-5353): wire something", foreignTaskId: "FN-5353" }]);
      expect(r.ownTrailed).toBe(1);
    });

    it("flags own-but-untrailed commits (hook didn't fire)", async () => {
      setupLog([
        { sha: "ccc", subject: "feat(FN-1): no trailer", body: "" },
      ]);
      const r = await reportBranchAttribution("/tmp/repo", "fusion/fn-1", "main", "FN-1");
      expect(r.ownUntrailed).toEqual([{ sha: "ccc", subject: "feat(FN-1): no trailer" }]);
      expect(r.ownTrailed).toBe(0);
    });

    it("flags unattributed commits (no subject pattern, no trailer)", async () => {
      setupLog([
        { sha: "ddd", subject: "hand-merge", body: "" },
      ]);
      const r = await reportBranchAttribution("/tmp/repo", "fusion/fn-1", "main", "FN-1");
      expect(r.unattributed).toEqual([{ sha: "ddd", subject: "hand-merge" }]);
    });

    it("returns empty report when range is empty", async () => {
      setupLog([]);
      const r = await reportBranchAttribution("/tmp/repo", "fusion/fn-1", "main", "FN-1");
      expect(r).toEqual({ ownTrailed: 0, ownUntrailed: [], foreign: [], unattributed: [] });
    });
  });

});
