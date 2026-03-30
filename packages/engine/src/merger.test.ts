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
  readFileSync: vi.fn(),
}));

import {
  aiMergeTask,
  findWorktreeUser,
  detectResolvableConflicts,
  autoResolveFile,
  resolveConflicts,
  type ConflictCategory,
} from "./merger.js";
import { createKbAgent } from "./pi.js";
import { execSync } from "node:child_process";
import { type TaskStore, type Task, type MergeResult, DEFAULT_SETTINGS } from "@kb/core";

const mockedCreateHaiAgent = vi.mocked(createKbAgent);
const mockedExecSync = vi.mocked(execSync);
const { existsSync: mockedExistsSyncRaw, readFileSync: mockedReadFileSyncRaw } = await import("node:fs");
const mockedExistsSync = vi.mocked(mockedExistsSyncRaw);
const mockedReadFileSync = vi.mocked(mockedReadFileSyncRaw);

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
 * rev-parse, log, diff, merge --squash, diff --cached --quiet (squash check),
 * diff --cached (post-agent verify), branch -d
 */
function setupHappyPathExecSync() {
  mockedExecSync.mockImplementation((cmd: any) => {
    const cmdStr = String(cmd);
    if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
    if (cmdStr.includes("git log")) return "- feat: something" as any;
    if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
    if (cmdStr.includes("merge --squash")) return Buffer.from("");
    // Post-squash check: --quiet means "did squash stage anything?" → "1" = yes
    if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
    // Post-agent check: "did agent commit?" → "0" = yes
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

describe("aiMergeTask — empty squash merge (branch already merged via dep)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("skips agent and still completes when squash stages nothing", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      // Squash staged nothing → "0"
      if (cmdStr.includes("diff --cached --quiet")) return "0" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore();
    const result = await aiMergeTask(store, "/tmp/root", "KB-050");

    expect(result.merged).toBe(true);
    // Agent should NOT have been spawned
    expect(mockedCreateHaiAgent).not.toHaveBeenCalled();
    // Task should still be moved to done
    expect(store.moveTask).toHaveBeenCalledWith("KB-050", "done");
  });

  it("still cleans up branch and worktree when squash is empty", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "0" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore();
    const result = await aiMergeTask(store, "/tmp/root", "KB-050");

    // Branch should be deleted
    const branchDeleteCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("branch -d"),
    );
    expect(branchDeleteCall).toBeDefined();
    expect(result.branchDeleted).toBe(true);

    // Worktree should be removed
    const worktreeRemoveCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("worktree remove"),
    );
    expect(worktreeRemoveCall).toBeDefined();
    expect(result.worktreeRemoved).toBe(true);
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

  it("triggers global pause when session.prompt() resolves with exhausted-retry error on state.error", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    // session.prompt() resolves normally, but session.state.error is set
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      state: { error: "429 Too Many Requests" },
    };
    mockedCreateHaiAgent.mockResolvedValue({ session: mockSession } as any);

    await expect(
      aiMergeTask(store, "/tmp/root", "KB-050", { usageLimitPauser: pauser }),
    ).rejects.toThrow("AI merge failed");

    // UsageLimitPauser should be called with "merger" agent type
    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "merger",
      "KB-050",
      "429 Too Many Requests",
    );
    // git reset --merge should be called to abort the merge
    const resetCalls = mockedExecSync.mock.calls.filter(
      (c) => String(c[0]).includes("reset --merge"),
    );
    expect(resetCalls.length).toBeGreaterThan(0);
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

// ── Conflict Detection & Auto-Resolution ─────────────────────────────────

describe("detectResolvableConflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no conflicts exist", () => {
    mockedExecSync.mockReturnValue(""); // Empty output = no conflicts

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toEqual([]);
  });

  it("detects package-lock.json as auto-resolvable with 'theirs' strategy", () => {
    mockedExecSync.mockReturnValue("package-lock.json\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filePath: "package-lock.json",
      autoResolvable: true,
      strategy: "ours",
      reason: "lock-file",
    });
  });

  it("detects pnpm-lock.yaml as lock file with 'ours' strategy", () => {
    mockedExecSync.mockReturnValue("pnpm-lock.yaml\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filePath: "pnpm-lock.yaml",
      autoResolvable: true,
      strategy: "ours",
      reason: "lock-file",
    });
  });

  it("detects yarn.lock as lock file with 'ours' strategy", () => {
    mockedExecSync.mockReturnValue("yarn.lock\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "ours",
      reason: "lock-file",
    });
  });

  it("detects Gemfile.lock as lock file with 'ours' strategy", () => {
    mockedExecSync.mockReturnValue("Gemfile.lock\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "ours",
      reason: "lock-file",
    });
  });

  it("detects .gen.ts files as generated files with 'ours' strategy", () => {
    mockedExecSync.mockReturnValue("src/types.gen.ts\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "ours",
      reason: "generated-file",
    });
  });

  it("detects dist/ paths as generated files", () => {
    mockedExecSync.mockReturnValue("dist/index.js\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "ours",
      reason: "generated-file",
    });
  });

  it("detects coverage/ paths as generated files", () => {
    mockedExecSync.mockReturnValue("coverage/lcov-report/index.html\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "ours",
      reason: "generated-file",
    });
  });

  it("marks regular source files as complex conflicts", () => {
    mockedExecSync.mockReturnValue("src/components/App.tsx\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      filePath: "src/components/App.tsx",
      autoResolvable: false,
      reason: "complex",
    });
  });

  it("handles multiple conflicted files with mixed categories", () => {
    mockedExecSync.mockReturnValue(
      "package-lock.json\nsrc/components/App.tsx\ndist/bundle.js\n",
    );

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(3);

    const lockFile = result.find((r) => r.filePath === "package-lock.json");
    const sourceFile = result.find((r) => r.filePath === "src/components/App.tsx");
    const distFile = result.find((r) => r.filePath === "dist/bundle.js");

    expect(lockFile).toMatchObject({ autoResolvable: true, reason: "lock-file" });
    expect(sourceFile).toMatchObject({ autoResolvable: false, reason: "complex" });
    expect(distFile).toMatchObject({ autoResolvable: true, reason: "generated-file" });
  });

  it("returns empty array on git command failure", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("git command failed");
    });

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toEqual([]);
  });
});

describe("autoResolveFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock returns empty buffer for all git commands
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  it("calls git checkout --theirs for 'theirs' resolution", () => {
    autoResolveFile("package-lock.json", "theirs", "/tmp/root");

    const checkoutCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git checkout --theirs"),
    );
    expect(checkoutCall).toBeDefined();
    expect(String(checkoutCall![0])).toContain("package-lock.json");
  });

  it("calls git checkout --ours for 'ours' resolution", () => {
    autoResolveFile("config.json", "ours", "/tmp/root");

    const checkoutCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git checkout --ours"),
    );
    expect(checkoutCall).toBeDefined();
    expect(String(checkoutCall![0])).toContain("config.json");
  });

  it("stages the resolved file with git add", () => {
    autoResolveFile("package-lock.json", "theirs", "/tmp/root");

    const addCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git add"),
    );
    expect(addCall).toBeDefined();
    expect(String(addCall![0])).toContain("package-lock.json");
  });

  it("throws error when git checkout fails", () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes("checkout")) {
        throw new Error("checkout failed");
      }
      return Buffer.from("");
    });

    expect(() => autoResolveFile("file.ts", "theirs", "/tmp/root")).toThrow(
      "Failed to auto-resolve",
    );
  });
});

describe("resolveConflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock - success
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  it("resolves lock files and returns remaining complex conflicts", () => {
    const categories: ConflictCategory[] = [
      { filePath: "package-lock.json", autoResolvable: true, strategy: "ours", reason: "lock-file" },
      { filePath: "src/App.tsx", autoResolvable: false, reason: "complex" },
      { filePath: "dist/bundle.js", autoResolvable: true, strategy: "ours", reason: "generated-file" },
    ];

    const remaining = resolveConflicts(categories, "/tmp/root");

    // Should have resolved package-lock.json and dist/bundle.js
    expect(remaining).toEqual(["src/App.tsx"]);

    // Should have called checkout and add for resolved files
    const checkoutCalls = mockedExecSync.mock.calls.filter((call) =>
      String(call[0]).includes("checkout"),
    );
    expect(checkoutCalls).toHaveLength(2);
  });

  it("returns all files when none are auto-resolvable", () => {
    const categories: ConflictCategory[] = [
      { filePath: "src/App.tsx", autoResolvable: false, reason: "complex" },
      { filePath: "src/utils.ts", autoResolvable: false, reason: "complex" },
    ];

    const remaining = resolveConflicts(categories, "/tmp/root");

    expect(remaining).toEqual(["src/App.tsx", "src/utils.ts"]);
    // No checkout calls should be made
    const checkoutCalls = mockedExecSync.mock.calls.filter((call) =>
      String(call[0]).includes("checkout"),
    );
    expect(checkoutCalls).toHaveLength(0);
  });

  it("returns empty array when all conflicts are resolved", () => {
    const categories: ConflictCategory[] = [
      { filePath: "package-lock.json", autoResolvable: true, strategy: "ours", reason: "lock-file" },
      { filePath: "yarn.lock", autoResolvable: true, strategy: "ours", reason: "lock-file" },
    ];

    const remaining = resolveConflicts(categories, "/tmp/root");

    expect(remaining).toEqual([]);
  });
});

// ── Trivial Conflict Detection Tests ──────────────────────────────────────

describe("trivial conflict detection (isTrivialConflict via detectResolvableConflicts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects whitespace-only conflicts as trivial", () => {
    mockedExecSync.mockReturnValue("src/utils.ts\n");

    const fileContent = `function foo() {
<<<<<<< HEAD
    return 1;
=======
        return 1;
>>>>>>> feature-branch
}`;

    mockedReadFileSync.mockReturnValue(fileContent);

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filePath: "src/utils.ts",
      autoResolvable: true,
      strategy: "ours",
      reason: "trivial",
    });
  });

  it("detects conflicts with different line endings as trivial", () => {
    mockedExecSync.mockReturnValue("src/utils.ts\n");

    // Same content but different line ending style - CRLF vs LF
    const fileContent = "const x = 1;\r\n<<<<<<< HEAD\r\nconst y = 2;\r\n=======\r\nconst y = 2;\n>>>>>>> feature-branch";

    mockedReadFileSync.mockReturnValue(fileContent);

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      reason: "trivial",
    });
  });

  it("marks conflicts with actual content differences as complex", () => {
    mockedExecSync.mockReturnValue("src/utils.ts\n");

    const fileContent = `function foo() {
<<<<<<< HEAD
    return 1;
=======
    return 2;
>>>>>>> feature-branch
}`;

    mockedReadFileSync.mockReturnValue(fileContent);

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filePath: "src/utils.ts",
      autoResolvable: false,
      reason: "complex",
    });
  });

  it("handles multiple conflict sections - all trivial", () => {
    mockedExecSync.mockReturnValue("src/utils.ts\n");

    const fileContent = `function foo() {
<<<<<<< HEAD
    return 1;
=======
        return 1;
>>>>>>> feature-branch
}
function bar() {
<<<<<<< Updated upstream
    const x = 2;
=======
        const x = 2;
>>>>>>> feature-branch
}`;

    mockedReadFileSync.mockReturnValue(fileContent);

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      reason: "trivial",
    });
  });

  it("handles multiple conflict sections - one non-trivial makes complex", () => {
    mockedExecSync.mockReturnValue("src/utils.ts\n");

    const fileContent = `function foo() {
<<<<<<< HEAD
    return 1;
=======
        return 1;
>>>>>>> feature-branch
}
function bar() {
<<<<<<< Updated upstream
    const x = 2;
=======
    const x = 999;
>>>>>>> feature-branch
}`;

    mockedReadFileSync.mockReturnValue(fileContent);

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      autoResolvable: false,
      reason: "complex",
    });
  });

  it("handles file read errors as complex conflicts", () => {
    mockedExecSync.mockReturnValue("src/utils.ts\n");
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      autoResolvable: false,
      reason: "complex",
    });
  });
});

// ── Retry Logic Tests ───────────────────────────────────────────────────

describe("aiMergeTask — retry logic with escalating strategies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);

    // Default mock: successful happy path
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash") || cmdStr.includes("merge -X")) return Buffer.from("");
      // Post-squash check: "1" = has staged changes
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      // Post-agent check: "0" = committed
      if (cmdStr.includes("diff --cached") && !cmdStr.includes("--quiet")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("attempt 1 success: sets resolutionStrategy to 'ai' and attemptsMade to 1", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    // Clean merge with no conflicts - simulate empty diff for conflicts
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      // No conflicts
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      // Has staged changes that need committing
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "KB-050");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("ai");
    expect(result.attemptsMade).toBe(1);
  });

  it("with autoResolveConflicts disabled: only makes 1 attempt on conflict", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      autoResolveConflicts: false, // Disabled
    });

    let agentCallCount = 0;

    // Simulate: merge succeeds but leaves conflicts, agent is called but fails
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("--stat")) return "1 file changed";

      if (cmdStr.includes("merge --squash")) {
        // Merge command succeeds but leaves conflict markers
        return Buffer.from("");
      }

      // Conflict detection returns conflicts
      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        return "src/file.ts\n";
      }

      // Staged changes check after merge (conflicts present but not staged)
      if (cmdStr.includes("diff --cached --quiet")) {
        return "1"; // Has staged changes from the merge
      }

      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    // Agent will be called and will fail
    mockedCreateHaiAgent.mockImplementation(() => {
      agentCallCount++;
      return Promise.resolve({
        session: {
          prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
          dispose: vi.fn(),
        },
      } as any);
    });

    await expect(aiMergeTask(store, "/tmp/root", "KB-050")).rejects.toThrow();

    // Should have called agent exactly once (no retries since autoResolve is disabled)
    expect(agentCallCount).toBe(1);
  });

  it("attempt 1 fails, attempt 2 auto-resolves lock files: sets resolutionStrategy to 'auto-resolve'", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    let mergeCallCount = 0;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("--stat")) return "1 file changed";

      if (cmdStr.includes("merge --squash")) {
        mergeCallCount++;
        if (mergeCallCount === 1) {
          // First attempt: conflict
          throw new Error("Merge conflict");
        }
        // Second attempt succeeds after auto-resolution
      }

      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        // First time: return lock file, second time: empty
        if (mergeCallCount === 1) return "package-lock.json\n";
        return "";
      }

      if (cmdStr.includes("checkout --ours")) return Buffer.from("");
      if (cmdStr.includes("git add")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "0"; // All resolved
      if (cmdStr.includes("branch -d")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("reset --merge")) return Buffer.from("");

      return Buffer.from("");
    });

    // Agent should not be called since all conflicts are auto-resolved
    const result = await aiMergeTask(store, "/tmp/root", "KB-050");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("auto-resolve");
    expect(result.attemptsMade).toBe(2);
  });

  it("attempt 3 uses -X theirs strategy: sets resolutionStrategy to 'theirs'", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    let squashCallCount = 0;
    let theirsCallCount = 0;
    let hasConflicts = true;
    let agentCallCount = 0;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("--stat")) return "1 file changed";

      // First two regular squash merges fail with conflicts
      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) {
        squashCallCount++;
        throw new Error("Merge conflict");
      }

      // Third attempt with -X theirs succeeds (no conflicts)
      if (cmdStr.includes("merge -X theirs --squash")) {
        theirsCallCount++;
        hasConflicts = false;
        return Buffer.from("");
      }

      // After -X theirs, no conflicts
      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        return hasConflicts ? "src/complex.ts\n" : "";
      }

      if (cmdStr.includes("diff --cached --quiet")) return hasConflicts ? "1" : "0";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("reset --merge")) return Buffer.from("");

      return Buffer.from("");
    });

    // Agent fails on attempt 2 (when called to resolve complex conflicts)
    mockedCreateHaiAgent.mockImplementation(() => {
      agentCallCount++;
      if (agentCallCount === 1) {
        // First agent call (attempt 2) fails
        return Promise.resolve({
          session: {
            prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
            dispose: vi.fn(),
          },
        } as any);
      }
      // Should not reach here
      return Promise.resolve({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
      } as any);
    });

    const result = await aiMergeTask(store, "/tmp/root", "KB-050");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("theirs");
    expect(result.attemptsMade).toBe(3);
    expect(theirsCallCount).toBe(1); // -X theirs was used once
    expect(agentCallCount).toBe(1); // Agent was called once (on attempt 2, which failed)
  });

  it("all 3 attempts fail: throws error and calls git reset --merge", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    const resetCalls: string[] = [];

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("--stat")) return "1 file changed";

      if (cmdStr.includes("merge --squash") || cmdStr.includes("merge -X theirs")) {
        // All merge attempts fail with conflicts
        throw new Error("Merge conflict");
      }

      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        return "src/always-conflicts.ts\n"; // Always has conflicts
      }

      if (cmdStr.includes("reset --merge")) {
        resetCalls.push(cmdStr);
        return Buffer.from("");
      }

      return Buffer.from("");
    });

    // Agent will also fail
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
        dispose: vi.fn(),
      },
    } as any);

    await expect(aiMergeTask(store, "/tmp/root", "KB-050")).rejects.toThrow(
      "all 3 attempts exhausted",
    );

    // Should have cleanup calls after each failed attempt plus final cleanup
    expect(resetCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("tracks resolutionStrategy as 'ai' when attempt 1 succeeds even with autoResolve enabled", async () => {
    const store = createMockStore(
      { id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "KB-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    // Clean merge with no conflicts
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return ""; // No conflicts
      if (cmdStr.includes("diff --cached --quiet")) return "1"; // Has staged changes
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "KB-050");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("ai");
    expect(result.attemptsMade).toBe(1);
  });
});
