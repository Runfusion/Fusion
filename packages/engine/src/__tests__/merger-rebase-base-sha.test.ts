import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn().mockResolvedValue({
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    },
  }),
  describeModel: vi.fn(() => "mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session, prompt, options) => {
    if (options === undefined) await session.prompt(prompt);
    else await session.prompt(prompt, options);
  }),
  compactSessionContext: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execSyncFn = vi.fn();
  const execFn: any = vi.fn((cmd: any, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    try {
      const out = execSyncFn(cmd, { stdio: ["pipe", "pipe", "pipe"] });
      callback?.(null, out?.toString?.() ?? "", "");
    } catch (err: any) {
      callback?.(err, err?.stdout?.toString?.() ?? "", err?.stderr?.toString?.() ?? "");
    }
  });
  execFn[promisify.custom] = (cmd: any, opts?: any) =>
    new Promise((resolve, reject) => {
      execFn(cmd, opts, (err: any, stdout: any, stderr: any) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });

  const execFileFn: any = vi.fn((file: any, args: any, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "function" ? {} : opts;
    const cmd = [file, ...(Array.isArray(args) ? args : [])].join(" ");
    try {
      const out = execSyncFn(cmd, { stdio: ["pipe", "pipe", "pipe"], ...options });
      callback?.(null, out?.toString?.() ?? "", "");
    } catch (err: any) {
      callback?.(err, err?.stdout?.toString?.() ?? "", err?.stderr?.toString?.() ?? "");
    }
  });
  execFileFn[promisify.custom] = (file: any, args?: any, opts?: any) =>
    new Promise((resolve, reject) => {
      execFileFn(file, args, opts, (err: any, stdout: any, stderr: any) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });

  return { execSync: execSyncFn, exec: execFn, execFile: execFileFn };
});

import { execSync } from "node:child_process";
import { DEFAULT_SETTINGS, type Task, type TaskStore } from "@fusion/core";
import { aiMergeTask } from "../merger.js";

const mockedExecSync = vi.mocked(execSync);

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  const task: Task = {
    id: "FN-050",
    title: "Test task",
    description: "Test",
    column: "in-review",
    dependencies: [],
    worktree: "/tmp/root/.worktrees/KB-050",
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    getTask: vi.fn().mockResolvedValue({ ...task, prompt: "# test" }),
    listTasks: vi.fn().mockResolvedValue([{ id: task.id, worktree: task.worktree, column: "in-review" }]),
    updateTask: vi.fn().mockResolvedValue(task),
    moveTask: vi.fn().mockResolvedValue(task),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn().mockResolvedValue({}),
    getSettings: vi.fn().mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    }),
    getActiveMergingTask: vi.fn().mockReturnValue(null),
    emit: vi.fn(),
    on: vi.fn(),
    clearStaleExecutionStartBranchReferences: vi.fn().mockReturnValue([]),
    getVerificationCacheHit: vi.fn().mockReturnValue(null),
    recordVerificationCachePass: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

describe("aiMergeTask rebaseBaseSha persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores rebaseBaseSha for rebase-routed merges", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, directMergeCommitStrategy: "always-rebase" }),
    });

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "rebasemergedsha";
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("rev-parse \"abc123\"")) return "rebasebase123";
      if (cmdStr.includes("rev-list --reverse \"rebasebase123..fusion/FN-050\"")) return "";
      if (cmdStr.includes("status --porcelain")) return "";
      if (cmdStr.includes("rev-parse --git-path CHERRY_PICK_HEAD")) return ".git/CHERRY_PICK_HEAD";
      if (cmdStr.includes("rev-parse --git-path sequencer")) return ".git/sequencer";
      if (cmdStr.includes("diff --shortstat \"rebasebase123..HEAD\"")) return "2 files changed, 5 insertions(+), 1 deletions(-)";
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");
    const mergeDetailsCall = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls.find((call: any[]) => call[1]?.mergeDetails);
    expect(mergeDetailsCall?.[1].mergeDetails.rebaseBaseSha).toBe("rebasebase123");
  });

  it("stores rebaseBaseSha for rebase-routed merges even when post-merge audit is off", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
        directMergeCommitStrategy: "always-rebase",
        postMergeAuditMode: "off",
      }),
    });

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "rebasemergedsha";
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("rev-parse \"abc123\"")) return "rebasebase123";
      if (cmdStr.includes("rev-list --reverse \"rebasebase123..fusion/FN-050\"")) return "";
      if (cmdStr.includes("status --porcelain")) return "";
      if (cmdStr.includes("rev-parse --git-path CHERRY_PICK_HEAD")) return ".git/CHERRY_PICK_HEAD";
      if (cmdStr.includes("rev-parse --git-path sequencer")) return ".git/sequencer";
      if (cmdStr.includes("diff --shortstat \"rebasebase123..HEAD\"")) return "2 files changed, 5 insertions(+), 1 deletions(-)";
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");
    const mergeDetailsCall = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls.find((call: any[]) => call[1]?.mergeDetails);
    expect(mergeDetailsCall?.[1].mergeDetails.rebaseBaseSha).toBe("rebasebase123");
  });

  it("leaves rebaseBaseSha undefined for squash merges", async () => {
    const store = createMockStore();

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123456789";
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("show --shortstat")) return "1 file changed, 1 insertion(+)";
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");
    const mergeDetailsCall = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls.find((call: any[]) => call[1]?.mergeDetails);
    expect(mergeDetailsCall?.[1].mergeDetails.rebaseBaseSha).toBeUndefined();
  });
});
