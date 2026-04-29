import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock child_process so we can intercept the `git push -u origin <branch>`
// call that processPullRequestMergeTask issues before createPr.
const execMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    try {
      const result = execMock(cmd, opts);
      cb(null, typeof result === "string" ? result : "", "");
    } catch (err) {
      cb(err as Error, "", (err as Error).message);
    }
  },
}));

import { processPullRequestMergeTask, getTaskBranchName } from "../task-lifecycle.js";

interface MockTask {
  id: string;
  title: string;
  description: string;
  worktree?: string;
  prInfo?: unknown;
  column: string;
}

function makeStore(task: MockTask, settings: Record<string, unknown> = {}) {
  const emitter = new EventEmitter();
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  return Object.assign(emitter, {
    getTask: vi.fn().mockResolvedValue(task),
    getSettings: vi.fn().mockResolvedValue({ requirePrApproval: false, ...settings }),
    updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
    }),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getActiveMergingTask: vi.fn().mockReturnValue(null),
    _updates: updates,
  });
}

describe("processPullRequestMergeTask", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it("pushes the per-task branch to origin before creating a new PR", async () => {
    const task: MockTask = {
      id: "FN-9001",
      title: "test",
      description: "desc",
      column: "in-review",
    };
    const branch = getTaskBranchName(task.id); // "fusion/fn-9001"
    const store = makeStore(task);

    const callOrder: string[] = [];
    execMock.mockImplementation((cmd: string) => {
      callOrder.push(`exec:${cmd}`);
      return "";
    });

    const github = {
      findPrForBranch: vi.fn(async () => {
        callOrder.push("findPrForBranch");
        return null;
      }),
      createPr: vi.fn(async () => {
        callOrder.push("createPr");
        return {
          number: 42,
          url: "https://github.com/x/y/pull/42",
          status: "open" as const,
          headBranch: branch,
          baseBranch: "main",
        };
      }),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 42, status: "open" as const, url: "https://github.com/x/y/pull/42" },
        reviewDecision: null,
        checks: [],
        mergeReady: false,
        blockingReasons: [],
      })),
      mergePr: vi.fn(),
    };

    const result = await processPullRequestMergeTask(
      store as never,
      "/repo",
      task.id,
      github as never,
      () => undefined,
    );

    expect(result).toBe("waiting");
    expect(github.findPrForBranch).toHaveBeenCalled();

    // The git push must happen after findPrForBranch and before createPr.
    const pushIdx = callOrder.findIndex((c) => c === `exec:git push -u origin "${branch}"`);
    const findIdx = callOrder.indexOf("findPrForBranch");
    const createIdx = callOrder.indexOf("createPr");
    expect(pushIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(findIdx);
    expect(pushIdx).toBeLessThan(createIdx);
  });

  it("skips the push when an existing PR already covers the branch", async () => {
    const task: MockTask = {
      id: "FN-9002",
      title: "test",
      description: "desc",
      column: "in-review",
    };
    const branch = getTaskBranchName(task.id);
    const store = makeStore(task);

    const pushed: string[] = [];
    execMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("git push")) pushed.push(cmd);
      return "";
    });

    const existingPr = {
      number: 7,
      url: "https://github.com/x/y/pull/7",
      status: "open" as const,
      headBranch: branch,
      baseBranch: "main",
    };

    const github = {
      findPrForBranch: vi.fn(async () => existingPr),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: existingPr,
        reviewDecision: null,
        checks: [],
        mergeReady: false,
        blockingReasons: [],
      })),
      mergePr: vi.fn(),
    };

    await processPullRequestMergeTask(
      store as never,
      "/repo",
      task.id,
      github as never,
      () => undefined,
    );

    expect(github.createPr).not.toHaveBeenCalled();
    expect(pushed).toEqual([]);
  });

  it("surfaces a clear error when the pre-create push fails", async () => {
    const task: MockTask = {
      id: "FN-9003",
      title: "test",
      description: "desc",
      column: "in-review",
    };
    const branch = getTaskBranchName(task.id);
    const store = makeStore(task);

    execMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("git push")) {
        throw new Error("remote rejected: permission denied");
      }
      return "";
    });

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn(),
      mergePr: vi.fn(),
    };

    await expect(
      processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined),
    ).rejects.toThrow(new RegExp(`Failed to push branch "${branch}" to origin`));

    expect(github.createPr).not.toHaveBeenCalled();
  });

  describe("requirePrApproval", () => {
    function makeReadyMergeStatus(reviewDecision: string | null) {
      const prInfo = {
        number: 100,
        url: "https://github.com/x/y/pull/100",
        status: "open" as const,
        headBranch: "fusion/fn-9100",
        baseBranch: "main",
      };
      // Simulate the "free private repo" case: GitHub reports no required
      // checks and no blocking review state, so isPrMergeReady returns
      // mergeReady: true. Without the gate this would auto-merge.
      return {
        prInfo,
        reviewDecision,
        checks: [],
        mergeReady: true,
        blockingReasons: [],
      };
    }

    it("holds the merge when requirePrApproval is true and reviewDecision is not APPROVED", async () => {
      const task: MockTask = {
        id: "FN-9100",
        title: "test",
        description: "desc",
        column: "in-review",
        prInfo: {
          number: 100,
          url: "https://github.com/x/y/pull/100",
          status: "open",
          headBranch: "fusion/fn-9100",
          baseBranch: "main",
        },
      };
      const store = makeStore(task, { requirePrApproval: true });

      const github = {
        findPrForBranch: vi.fn(),
        createPr: vi.fn(),
        getPrMergeStatus: vi.fn(async () => makeReadyMergeStatus(null)),
        mergePr: vi.fn(),
      };

      const result = await processPullRequestMergeTask(
        store as never,
        "/repo",
        task.id,
        github as never,
        () => undefined,
      );

      expect(result).toBe("waiting");
      expect(github.mergePr).not.toHaveBeenCalled();
      const lastUpdate = (store as { _updates: Array<{ patch: Record<string, unknown> }> })._updates.at(-1);
      expect(lastUpdate?.patch).toEqual({ status: "awaiting-pr-checks" });
    });

    it("merges when requirePrApproval is true and reviewDecision is APPROVED", async () => {
      const task: MockTask = {
        id: "FN-9101",
        title: "test",
        description: "desc",
        column: "in-review",
        prInfo: {
          number: 100,
          url: "https://github.com/x/y/pull/100",
          status: "open",
          headBranch: "fusion/fn-9101",
          baseBranch: "main",
        },
      };
      const store = makeStore(task, { requirePrApproval: true });

      const merged = {
        number: 100,
        url: "https://github.com/x/y/pull/100",
        status: "merged" as const,
        headBranch: "fusion/fn-9101",
        baseBranch: "main",
      };
      const github = {
        findPrForBranch: vi.fn(),
        createPr: vi.fn(),
        getPrMergeStatus: vi.fn(async () => makeReadyMergeStatus("APPROVED")),
        mergePr: vi.fn(async () => merged),
      };

      const result = await processPullRequestMergeTask(
        store as never,
        "/repo",
        task.id,
        github as never,
        () => undefined,
      );

      expect(result).toBe("merged");
      expect(github.mergePr).toHaveBeenCalledWith({ number: 100, method: "squash" });
    });

    it("preserves existing behavior when requirePrApproval is false", async () => {
      const task: MockTask = {
        id: "FN-9102",
        title: "test",
        description: "desc",
        column: "in-review",
        prInfo: {
          number: 100,
          url: "https://github.com/x/y/pull/100",
          status: "open",
          headBranch: "fusion/fn-9102",
          baseBranch: "main",
        },
      };
      const store = makeStore(task, { requirePrApproval: false });

      const merged = {
        number: 100,
        url: "https://github.com/x/y/pull/100",
        status: "merged" as const,
        headBranch: "fusion/fn-9102",
        baseBranch: "main",
      };
      const github = {
        findPrForBranch: vi.fn(),
        createPr: vi.fn(),
        // reviewDecision: null but mergeReady: true — without the gate,
        // this should still merge (the buggy default that #21's reviewer
        // flagged as too aggressive on free private repos).
        getPrMergeStatus: vi.fn(async () => makeReadyMergeStatus(null)),
        mergePr: vi.fn(async () => merged),
      };

      const result = await processPullRequestMergeTask(
        store as never,
        "/repo",
        task.id,
        github as never,
        () => undefined,
      );

      expect(result).toBe("merged");
      expect(github.mergePr).toHaveBeenCalled();
    });
  });
});
