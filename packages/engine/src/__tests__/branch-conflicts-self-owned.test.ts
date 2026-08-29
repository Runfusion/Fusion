import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { inspectBranchConflict } from "../execution/branch-conflicts.js";

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);

describe("branch-conflicts self-owned classifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("returns reclaimable for self-owned branch with zero task-attributed commits", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree prune") return Buffer.from("");
      if (command === "git worktree list --porcelain") {
        return Buffer.from(["worktree /tmp/wt-fn-4485", "HEAD 222", "branch refs/heads/fusion/fn-4485", ""].join("\n"));
      }
      if (command.includes("git rev-parse --verify 'refs/heads/fusion/fn-4485^{commit}'")) return Buffer.from("tipsha\n");
      if (command.includes("git rev-parse --verify 'fusion/fn-4485^{commit}'")) return Buffer.from("tipsha\n");
      if (command.includes("git rev-parse --verify 'main^{commit}'")) return Buffer.from("mainsha\n");
      if (command === "git merge-base 'main' 'fusion/fn-4485'") return Buffer.from("base123\n");
      if (command === "git cherry 'main' 'fusion/fn-4485' 'base123'") return Buffer.from("+ aaa111\n");
      if (command.includes("git rev-parse --verify 'aaa111^{commit}'")) return Buffer.from("aaa111\n");
      if (command === "git log -1 --format=%s 'aaa111'") return Buffer.from("prior work\n");
      if (command.includes("git log --format=%H%x00%s%x00%b 'main..fusion/fn-4485'")) {
        return Buffer.from("aaa111\u0000chore: prior work\u0000\u0000");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await inspectBranchConflict({
      repoDir: "/tmp/repo",
      branchName: "fusion/fn-4485",
      conflictingWorktreePath: "/tmp/wt-fn-4485",
      requestingTaskId: "FN-4485",
      ownerTaskId: "FN-4485",
      startPoint: "main",
    });

    expect(result.kind).toBe("reclaimable");
    if (result.kind !== "reclaimable") throw new Error("expected reclaimable");
    expect(result.taskAttributedCommitCount).toBe(0);
  });

  it("returns reclaimable for self-owned branch with positive task-attributed commits", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree prune") return Buffer.from("");
      if (command === "git worktree list --porcelain") {
        return Buffer.from(["worktree /tmp/wt-fn-4485", "HEAD 222", "branch refs/heads/fusion/fn-4485", ""].join("\n"));
      }
      if (command.includes("git rev-parse --verify 'refs/heads/fusion/fn-4485^{commit}'")) return Buffer.from("tipsha\n");
      if (command.includes("git rev-parse --verify 'fusion/fn-4485^{commit}'")) return Buffer.from("tipsha\n");
      if (command.includes("git rev-parse --verify 'main^{commit}'")) return Buffer.from("mainsha\n");
      if (command === "git merge-base 'main' 'fusion/fn-4485'") return Buffer.from("base123\n");
      if (command === "git cherry 'main' 'fusion/fn-4485' 'base123'") return Buffer.from("+ aaa111\n");
      if (command.includes("git rev-parse --verify 'aaa111^{commit}'")) return Buffer.from("aaa111\n");
      if (command === "git log -1 --format=%s 'aaa111'") return Buffer.from("owned work\n");
      if (command.includes("git log --format=%H%x00%s%x00%b 'main..fusion/fn-4485'")) {
        return Buffer.from("aaa111\u0000feat(FN-4485): owned\u0000Fusion-Task-Id: FN-4485\u0000");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await inspectBranchConflict({
      repoDir: "/tmp/repo",
      branchName: "fusion/fn-4485",
      conflictingWorktreePath: "/tmp/wt-fn-4485",
      requestingTaskId: "FN-4485",
      startPoint: "main",
    });

    expect(result.kind).toBe("reclaimable");
    if (result.kind !== "reclaimable") throw new Error("expected reclaimable");
    expect(result.taskAttributedCommitCount).toBe(1);
  });

  it("keeps foreign worktree conflicts as live-foreign", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree prune") return Buffer.from("");
      if (command === "git worktree list --porcelain") {
        return Buffer.from(["worktree /tmp/wt-fn-9999", "HEAD 222", "branch refs/heads/topic/other", ""].join("\n"));
      }
      if (command.includes("git rev-parse --verify 'refs/heads/topic/other^{commit}'")) return Buffer.from("tipsha\n");
      if (command.includes("git rev-parse --verify 'topic/other^{commit}'")) return Buffer.from("tipsha\n");
      if (command.includes("git rev-parse --verify 'main^{commit}'")) return Buffer.from("mainsha\n");
      if (command === "git merge-base 'main' 'topic/other'") return Buffer.from("base123\n");
      if (command === "git cherry 'main' 'topic/other' 'base123'") return Buffer.from("+ aaa111\n");
      if (command.includes("git rev-parse --verify 'aaa111^{commit}'")) return Buffer.from("aaa111\n");
      if (command === "git log -1 --format=%s 'aaa111'") return Buffer.from("foreign work\n");
      if (command.includes("git log --format=%H%x00%s%x00%b 'main..topic/other'")) {
        return Buffer.from("aaa111\u0000feat(FN-9999): foreign\u0000Fusion-Task-Id: FN-9999\u0000");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await inspectBranchConflict({
      repoDir: "/tmp/repo",
      branchName: "topic/other",
      conflictingWorktreePath: "/tmp/requesting-wt",
      requestingTaskId: "FN-4485",
      ownerTaskId: "FN-4485",
      startPoint: "main",
    });

    expect(result.kind).toBe("live-foreign");
  });

  it("keeps stale-resolved when branch ref is gone", async () => {
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree prune") return Buffer.from("");
      if (command === "git worktree list --porcelain") {
        return Buffer.from(["worktree /tmp/wt", "HEAD 222", "branch refs/heads/main", ""].join("\n"));
      }
      if (command.includes("git rev-parse --verify 'refs/heads/fusion/fn-4485^{commit}'")) {
        throw new Error("missing");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await inspectBranchConflict({
      repoDir: "/tmp/repo",
      branchName: "fusion/fn-4485",
      conflictingWorktreePath: "/tmp/wt-fn-4485",
      requestingTaskId: "FN-4485",
      startPoint: "main",
    });

    expect(result).toEqual({ kind: "stale-resolved" });
  });
});
