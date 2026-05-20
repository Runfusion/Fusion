import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn(() => "mock-provider/mock-model"),
  promptWithFallback: vi.fn(),
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
import { mergerLog } from "../logger.js";

const mockedExecSync = vi.mocked(execSync);

function createMockStore(column: Task["column"]): TaskStore {
  const task: Task = {
    id: "FN-5007",
    title: "Test task",
    description: "Test",
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return {
    getTask: vi.fn().mockResolvedValue({ ...task, prompt: "# test" }),
    listTasks: vi.fn().mockResolvedValue([]),
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
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

describe("aiMergeTask finalized-task guard (FN-5007)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["done", "archived"] as const)("short-circuits for %s tasks", async (column) => {
    const store = createMockStore(column);
    const logSpy = vi.spyOn(mergerLog, "log").mockImplementation(() => undefined);

    const result = await aiMergeTask(store, "/tmp/root", "FN-5007");

    expect(result.merged).toBe(false);
    expect(result.noOp).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("already-finalized");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain("task already finalized");
    const auditCalls = (store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls;
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.[0]?.mutationType).toBe("task:auto-merge-skipped-already-done");
    const commandCalls = mockedExecSync.mock.calls.map((call) => String(call[0]));
    expect(commandCalls.some((cmd) => cmd.includes("merge --squash"))).toBe(false);
    expect(commandCalls.some((cmd) => cmd.includes("stash"))).toBe(false);
  });

  it("does not short-circuit in-review tasks", async () => {
    const store = createMockStore("in-review");
    const logSpy = vi.spyOn(mergerLog, "log").mockImplementation(() => undefined);

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmdStr.includes("git log")) return "- feat: test";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("merge --squash")) throw new Error("forced stop after merge invocation");
      return Buffer.from("");
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-5007")).rejects.toThrow("forced stop after merge invocation");
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("task already finalized"));
    const commandCalls = mockedExecSync.mock.calls.map((call) => String(call[0]));
    expect(commandCalls.some((cmd) => cmd.includes("merge --squash"))).toBe(true);
  });
});
