import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies
vi.mock("./pi.js", () => ({
  createKbAgent: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

import { aiMergeTask, findWorktreeUser } from "./merger.js";
import { createKbAgent } from "./pi.js";
import { execSync } from "node:child_process";
import { type TaskStore, type Task, type MergeResult, DEFAULT_SETTINGS } from "@kb/core";

const mockedCreateHaiAgent = vi.mocked(createKbAgent);
const mockedExecSync = vi.mocked(execSync);
const { existsSync: mockedExistsSyncRaw } = await import("node:fs");
const mockedExistsSync = vi.mocked(mockedExistsSyncRaw);

function createMockStore(taskOverrides: Partial<Task> = {}, allTasks: Task[] = []) {
  const baseTask: Task = {
    id: "KB-050",
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
    ...taskOverrides,
  };

  return {
    getTask: vi.fn().mockResolvedValue({ ...baseTask, prompt: "# test" }),
    listTasks: vi.fn().mockResolvedValue(allTasks),
    updateTask: vi.fn().mockResolvedValue(baseTask),
    moveTask: vi.fn().mockResolvedValue(baseTask),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn().mockResolvedValue({}),
    getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS }),
    emit: vi.fn(),
    on: vi.fn(),
  } as unknown as TaskStore;
}

/**
 * Set up execSync to handle the standard merge flow:
 * rev-parse, log, diff, merge --squash, diff --cached, branch -d
 */
function setupHappyPathExecSync() {
  mockedExecSync.mockImplementation((cmd: any) => {
    const cmdStr = String(cmd);
    if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
    if (cmdStr.includes("git log")) return "- feat: something" as any;
    if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
    if (cmdStr.includes("merge --squash")) return Buffer.from("");
    if (cmdStr.includes("diff --cached")) return "0" as any;
    if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
    if (cmdStr.includes("worktree remove")) return Buffer.from("");
    return Buffer.from("");
  });
}

describe("findWorktreeUser", () => {
  it("returns null when no other task uses the worktree", async () => {
    const store = createMockStore({}, [
      { id: "KB-050", worktree: "/tmp/wt", column: "done" } as Task,
    ]);
    const result = await findWorktreeUser(store, "/tmp/wt", "KB-050");
    expect(result).toBeNull();
  });

  it("returns task ID when another non-done task uses the worktree", async () => {
    const store = createMockStore({}, [
      { id: "KB-050", worktree: "/tmp/wt", column: "done" } as Task,
      { id: "KB-051", worktree: "/tmp/wt", column: "in-progress" } as Task,
    ]);
    const result = await findWorktreeUser(store, "/tmp/wt", "KB-050");
    expect(result).toBe("KB-051");
  });

  it("ignores done tasks", async () => {
    const store = createMockStore({}, [
      { id: "KB-050", worktree: "/tmp/wt", column: "done" } as Task,
      { id: "KB-051", worktree: "/tmp/wt", column: "done" } as Task,
    ]);
    const result = await findWorktreeUser(store, "/tmp/wt", "KB-050");
    expect(result).toBeNull();
  });
});

describe("aiMergeTask — conditional worktree cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("does NOT remove worktree when another task references the same path", async () => {
    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "KB-050", worktree: worktreePath },
      [
        { id: "KB-050", worktree: worktreePath, column: "in-review" } as Task,
        { id: "KB-051", worktree: worktreePath, column: "in-progress" } as Task,
      ],
    );

    const result = await aiMergeTask(store, "/tmp/root", "KB-050");

    // Worktree should NOT be removed
    const removeCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("worktree remove"),
    );
    expect(removeCall).toBeUndefined();
    expect(result.worktreeRemoved).toBe(false);
  });

  it("removes worktree when no other task references it", async () => {
    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "KB-050", worktree: worktreePath },
      [
        { id: "KB-050", worktree: worktreePath, column: "in-review" } as Task,
      ],
    );

    const result = await aiMergeTask(store, "/tmp/root", "KB-050");

    const removeCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("worktree remove"),
    );
    expect(removeCall).toBeDefined();
    expect(result.worktreeRemoved).toBe(true);
  });

  it("always deletes the branch regardless of worktree sharing", async () => {
    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "KB-050", worktree: worktreePath },
      [
        { id: "KB-050", worktree: worktreePath, column: "in-review" } as Task,
        { id: "KB-051", worktree: worktreePath, column: "in-progress" } as Task,
      ],
    );

    const result = await aiMergeTask(store, "/tmp/root", "KB-050");

    // Branch should be deleted even though worktree is shared
    const branchDeleteCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("branch -d") || String(call[0]).includes("branch -D"),
    );
    expect(branchDeleteCall).toBeDefined();
    expect(result.branchDeleted).toBe(true);
  });

  it("result.worktreeRemoved is false when worktree is retained", async () => {
    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "KB-050", worktree: worktreePath },
      [
        { id: "KB-050", worktree: worktreePath, column: "in-review" } as Task,
        { id: "KB-051", worktree: worktreePath, column: "todo" } as Task,
      ],
    );

    const result = await aiMergeTask(store, "/tmp/root", "KB-050");
    expect(result.worktreeRemoved).toBe(false);
    expect(result.merged).toBe(true);
  });
});

describe("aiMergeTask — includeTaskIdInCommit setting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("includes task ID in system prompt by default (includeTaskIdInCommit: true)", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "KB-050");

    const agentCall = mockedCreateHaiAgent.mock.calls[0][0] as any;
    expect(agentCall.systemPrompt).toContain("<type>(<scope>): <summary>");
    expect(agentCall.systemPrompt).toContain("the task ID");
  });

  it("omits task ID scope in system prompt when includeTaskIdInCommit is false", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      includeTaskIdInCommit: false,
    });

    await aiMergeTask(store, "/tmp/root", "KB-050");

    const agentCall = mockedCreateHaiAgent.mock.calls[0][0] as any;
    expect(agentCall.systemPrompt).toContain("<type>: <summary>");
    expect(agentCall.systemPrompt).not.toContain("<type>(<scope>): <summary>");
    expect(agentCall.systemPrompt).toContain("Do NOT include a scope");
  });

  it("fallback commit includes task ID when includeTaskIdInCommit is true", async () => {
    // Make staged check return "1" so fallback is triggered
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached")) return "1" as any;
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "KB-050");

    const commitCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("git commit"),
    );
    expect(commitCall).toBeDefined();
    expect(String(commitCall![0])).toContain("feat(KB-050):");
  });

  it("fallback commit omits task ID when includeTaskIdInCommit is false", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached")) return "1" as any;
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      includeTaskIdInCommit: false,
    });

    await aiMergeTask(store, "/tmp/root", "KB-050");

    const commitCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("git commit"),
    );
    expect(commitCall).toBeDefined();
    expect(String(commitCall![0])).toContain("feat: merge");
    expect(String(commitCall![0])).not.toContain("feat(KB-050)");
  });
});

describe("aiMergeTask — model settings threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("passes defaultProvider and defaultModelId from settings to createKbAgent", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });

    await aiMergeTask(store, "/tmp/root", "KB-050");

    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateHaiAgent.mock.calls[0][0] as any;
    expect(opts.defaultProvider).toBe("openai");
    expect(opts.defaultModelId).toBe("gpt-4o");
  });

  it("does not set model fields when settings omit them", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "KB-050");

    const opts = mockedCreateHaiAgent.mock.calls[0][0] as any;
    expect(opts.defaultProvider).toBeUndefined();
    expect(opts.defaultModelId).toBeUndefined();
  });
});

describe("aiMergeTask — agent log persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
  });

  it("logs text deltas to store.appendAgentLog", async () => {
    let capturedOnText: ((delta: string) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnText = opts.onText;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            capturedOnText?.("Hello ");
            capturedOnText?.("merge");
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "KB-050", worktree: worktreePath },
      [{ id: "KB-050", worktree: worktreePath, column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "KB-050");

    expect(store.appendAgentLog).toHaveBeenCalledWith("KB-050", "Hello merge", "text", undefined, "merger");
  });

  it("logs tool invocations to store.appendAgentLog", async () => {
    let capturedOnToolStart: ((name: string, args: any) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnToolStart = opts.onToolStart;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            capturedOnToolStart?.("Bash", { command: "git status" });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "KB-050", worktree: worktreePath },
      [{ id: "KB-050", worktree: worktreePath, column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "KB-050");

    expect(store.appendAgentLog).toHaveBeenCalledWith("KB-050", "Bash", "tool", "git status", "merger");
  });

  it("still fires onAgentText callback alongside logging", async () => {
    const onAgentText = vi.fn();
    let capturedOnText: ((delta: string) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnText = opts.onText;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            capturedOnText?.("hi");
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "KB-050", worktree: worktreePath },
      [{ id: "KB-050", worktree: worktreePath, column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "KB-050", { onAgentText });

    expect(onAgentText).toHaveBeenCalledWith("hi");
    expect(store.appendAgentLog).toHaveBeenCalledWith("KB-050", "hi", "text", undefined, "merger");
  });
});

// ── Usage limit detection in merger ──────────────────────────────────

import { UsageLimitPauser } from "./usage-limit-detector.js";

describe("aiMergeTask — usage limit detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
  });

  it("triggers global pause when merger catches a usage-limit error", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("rate_limit_error: Rate limit exceeded")),
        dispose: vi.fn(),
      },
    } as any);

    await expect(
      aiMergeTask(store, "/tmp/root", "KB-050", { usageLimitPauser: pauser }),
    ).rejects.toThrow("AI merge failed");

    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "merger",
      "KB-050",
      "rate_limit_error: Rate limit exceeded",
    );
    expect(store.updateSettings).toHaveBeenCalledWith({ globalPause: true });
  });

  it("does NOT trigger global pause for non-usage-limit errors", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("connection refused")),
        dispose: vi.fn(),
      },
    } as any);

    await expect(
      aiMergeTask(store, "/tmp/root", "KB-050", { usageLimitPauser: pauser }),
    ).rejects.toThrow("AI merge failed");

    expect(onUsageLimitHitSpy).not.toHaveBeenCalled();
  });

  it("works without usageLimitPauser (backward compatible)", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("rate_limit_error: Rate limit exceeded")),
        dispose: vi.fn(),
      },
    } as any);

    // Should not crash — just re-throw
    await expect(
      aiMergeTask(store, "/tmp/root", "KB-050"),
    ).rejects.toThrow("AI merge failed");
  });

  it("triggers global pause for overloaded error", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("overloaded_error: Overloaded")),
        dispose: vi.fn(),
      },
    } as any);

    await expect(
      aiMergeTask(store, "/tmp/root", "KB-050", { usageLimitPauser: pauser }),
    ).rejects.toThrow("AI merge failed");

    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "merger",
      "KB-050",
      "overloaded_error: Overloaded",
    );
  });
});

describe("aiMergeTask — onSession callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
  });

  it("calls onSession with the session object after creation", async () => {
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };

    mockedCreateHaiAgent.mockResolvedValue({
      session: mockSession,
    } as any);

    const onSession = vi.fn();
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "KB-050", { onSession });

    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith(mockSession);
  });

  it("works without onSession callback (backward compatible)", async () => {
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    // Should not crash without onSession
    await expect(aiMergeTask(store, "/tmp/root", "KB-050")).resolves.toBeDefined();
  });
});
