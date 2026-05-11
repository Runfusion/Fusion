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
  baseBranch?: string;
  branchContext?: {
    groupId: string;
    source: "planning" | "mission";
    assignmentMode: "shared" | "per-task-derived";
    inheritedBaseBranch?: string;
  };
  prInfo?: {
    number: number;
    url: string;
    status: "open" | "closed" | "merged";
    headBranch?: string;
    baseBranch?: string;
    title?: string;
    commentCount?: number;
    lastCheckedAt?: string;
  };
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

function makeStatefulStore(task: MockTask, settings: Record<string, unknown> = {}) {
  const emitter = new EventEmitter();
  let state = structuredClone(task);
  return Object.assign(emitter, {
    getTask: vi.fn(async () => structuredClone(state)),
    getSettings: vi.fn().mockResolvedValue({ requirePrApproval: false, ...settings }),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      state = { ...state, ...patch };
    }),
    updatePrInfo: vi.fn(async (_id: string, prInfo: MockTask["prInfo"]) => {
      state = { ...state, prInfo: prInfo ?? undefined };
      return structuredClone(state);
    }),
    moveTask: vi.fn(async (_id: string, column: string) => {
      state = { ...state, column };
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getActiveMergingTask: vi.fn().mockReturnValue(null),
    _getState: () => state,
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

  it("uses inherited branch-context merge target when creating a PR", async () => {
    const task: MockTask = {
      id: "FN-9002",
      title: "test",
      description: "desc",
      column: "in-review",
      branchContext: {
        groupId: "planning:abc",
        source: "planning",
        assignmentMode: "shared",
        inheritedBaseBranch: "develop",
      },
    };
    const branch = getTaskBranchName(task.id);
    const store = makeStore(task, { baseBranch: "main" });
    execMock.mockImplementation(() => "");

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => ({
        number: 7,
        url: "https://github.com/x/y/pull/7",
        status: "open" as const,
        headBranch: branch,
        baseBranch: "develop",
      })),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 7, status: "open" as const, url: "https://github.com/x/y/pull/7" },
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

    expect(github.createPr).toHaveBeenCalledWith(expect.objectContaining({
      base: "develop",
    }));
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

  it("fails before push when the task branch is missing locally and remotely", async () => {
    const task: MockTask = {
      id: "FN-9010",
      title: "test",
      description: "desc",
      column: "in-review",
    };
    const branch = getTaskBranchName(task.id);
    const store = makeStore(task);

    const commands: string[] = [];
    execMock.mockImplementation((cmd: string) => {
      commands.push(cmd);
      if (cmd.startsWith("git show-ref")) {
        const err = new Error("not found") as Error & { code?: number };
        err.code = 1;
        throw err;
      }
      if (cmd.startsWith("git ls-remote")) {
        const err = new Error("not found") as Error & { code?: number };
        err.code = 2;
        throw err;
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
    ).rejects.toThrow(`Cannot create PR for missing task branch "${branch}"`);

    expect(commands.some((cmd) => cmd.startsWith("git push"))).toBe(false);
    expect(github.createPr).not.toHaveBeenCalled();
  });

  it("rethrows unexpected remote lookup failures instead of treating them as missing branches", async () => {
    const task: MockTask = {
      id: "FN-9013",
      title: "test",
      description: "desc",
      column: "in-review",
    };
    const store = makeStore(task);

    const commands: string[] = [];
    execMock.mockImplementation((cmd: string) => {
      commands.push(cmd);
      if (cmd.startsWith("git show-ref")) {
        const err = new Error("not found") as Error & { code?: number };
        err.code = 1;
        throw err;
      }
      if (cmd.startsWith("git ls-remote")) {
        const err = new Error("fatal: unable to access remote") as Error & { code?: number };
        err.code = 128;
        throw err;
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
    ).rejects.toThrow("fatal: unable to access remote");

    expect(commands.some((cmd) => cmd.startsWith("git push"))).toBe(false);
    expect(github.createPr).not.toHaveBeenCalled();
  });

  it("skips push when the local branch is gone but the remote task branch exists", async () => {
    const task: MockTask = {
      id: "FN-9011",
      title: "test",
      description: "desc",
      column: "in-review",
    };
    const branch = getTaskBranchName(task.id);
    const store = makeStore(task);

    const commands: string[] = [];
    execMock.mockImplementation((cmd: string) => {
      commands.push(cmd);
      if (cmd.startsWith("git show-ref")) {
        const err = new Error("not found") as Error & { code?: number };
        err.code = 1;
        throw err;
      }
      return "";
    });

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => ({
        number: 43,
        url: "https://github.com/x/y/pull/43",
        status: "open" as const,
        headBranch: branch,
        baseBranch: "main",
      })),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 43, status: "open" as const, url: "https://github.com/x/y/pull/43" },
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
    expect(commands.some((cmd) => cmd.startsWith("git ls-remote"))).toBe(true);
    expect(commands.some((cmd) => cmd.startsWith("git push"))).toBe(false);
    expect(github.createPr).toHaveBeenCalledWith(expect.objectContaining({ head: branch }));
  });

  it("parks no-delta branches instead of retrying into branch push failures", async () => {
    const task: MockTask = {
      id: "FN-9012",
      title: "test",
      description: "desc",
      column: "in-review",
    };
    const branch = getTaskBranchName(task.id);
    const store = makeStore(task);
    execMock.mockImplementation(() => "");

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => {
        throw new Error(`GraphQL: No commits between main and ${branch} (createPullRequest)`);
      }),
      getPrMergeStatus: vi.fn(),
      mergePr: vi.fn(),
    };

    const result = await processPullRequestMergeTask(
      store as never,
      "/repo",
      task.id,
      github as never,
      () => undefined,
    );

    expect(result).toBe("skipped");
    expect(store.updateTask).toHaveBeenCalledWith(task.id, {
      status: "failed",
      error: `No pull request created for ${branch}: the branch has no commits relative to the base branch.`,
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      `No pull request created for ${branch}: the branch has no commits relative to the base branch.`,
      expect.stringContaining("No commits between"),
    );
  });

  it("finalizes task cleanup when PR is already merged on status refresh", async () => {
    const task: MockTask = {
      id: "FN-9004",
      title: "test",
      description: "desc",
      column: "in-review",
      worktree: "/tmp/worktree-fn-9004",
      prInfo: {
        number: 88,
        url: "https://github.com/x/y/pull/88",
        status: "open",
        headBranch: "fusion/fn-9004",
        baseBranch: "main",
      },
    };
    const store = makeStore(task);
    execMock.mockImplementation(() => "");

    const github = {
      findPrForBranch: vi.fn(),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: {
          number: 88,
          url: "https://github.com/x/y/pull/88",
          status: "merged" as const,
          headBranch: "fusion/fn-9004",
          baseBranch: "main",
        },
        reviewDecision: "APPROVED",
        checks: [],
        mergeReady: true,
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

    expect(result).toBe("merged");
    expect(github.mergePr).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-9004", { status: null, mergeRetries: 0 });
    expect(store.moveTask).toHaveBeenCalledWith("FN-9004", "done");
  });

  it("reconciles to done when PR merges after readiness check but before merge command completes", async () => {
    const task: MockTask = {
      id: "FN-9104",
      title: "test",
      description: "desc",
      column: "in-review",
      worktree: "/tmp/worktree-fn-9104",
      prInfo: {
        number: 124,
        url: "https://github.com/x/y/pull/124",
        status: "open",
        headBranch: "fusion/fn-9104",
        baseBranch: "main",
      },
    };
    const store = makeStore(task);
    execMock.mockImplementation(() => "");

    const openPr = {
      number: 124,
      url: "https://github.com/x/y/pull/124",
      status: "open" as const,
      headBranch: "fusion/fn-9104",
      baseBranch: "main",
    };
    const mergedPr = {
      ...openPr,
      status: "merged" as const,
    };
    const github = {
      findPrForBranch: vi.fn(),
      createPr: vi.fn(),
      getPrMergeStatus: vi
        .fn()
        .mockResolvedValueOnce({
          prInfo: openPr,
          reviewDecision: "APPROVED",
          checks: [],
          mergeReady: true,
          blockingReasons: [],
        })
        .mockResolvedValueOnce({
          prInfo: mergedPr,
          reviewDecision: "APPROVED",
          checks: [],
          mergeReady: true,
          blockingReasons: [],
        }),
      mergePr: vi.fn(async () => {
        throw new Error("Pull request is not mergeable: the merge commit cannot be cleanly created");
      }),
    };

    const result = await processPullRequestMergeTask(
      store as never,
      "/repo",
      task.id,
      github as never,
      () => undefined,
    );

    expect(result).toBe("merged");
    expect(github.mergePr).toHaveBeenCalledWith({ number: 124, method: "squash" });
    expect(github.getPrMergeStatus).toHaveBeenCalledTimes(2);
    expect(store.updatePrInfo).toHaveBeenLastCalledWith("FN-9104", expect.objectContaining({ status: "merged" }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-9104", { status: null, mergeRetries: 0 });
    expect(store.moveTask).toHaveBeenCalledWith("FN-9104", "done");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-9104",
      "Pull request already merged after merge command failed; reconciled task state from GitHub",
      "PR #124: https://github.com/x/y/pull/124",
    );
  });

  it("rethrows the original merge error when refresh does not confirm merged", async () => {
    const task: MockTask = {
      id: "FN-9105",
      title: "test",
      description: "desc",
      column: "in-review",
      prInfo: {
        number: 125,
        url: "https://github.com/x/y/pull/125",
        status: "open",
        headBranch: "fusion/fn-9105",
        baseBranch: "main",
      },
    };
    const store = makeStore(task);
    const mergeError = new Error("Pull request is not mergeable");
    const openPr = {
      number: 125,
      url: "https://github.com/x/y/pull/125",
      status: "open" as const,
      headBranch: "fusion/fn-9105",
      baseBranch: "main",
    };
    const github = {
      findPrForBranch: vi.fn(),
      createPr: vi.fn(),
      getPrMergeStatus: vi
        .fn()
        .mockResolvedValueOnce({
          prInfo: openPr,
          reviewDecision: "APPROVED",
          checks: [],
          mergeReady: true,
          blockingReasons: [],
        })
        .mockResolvedValueOnce({
          prInfo: openPr,
          reviewDecision: "APPROVED",
          checks: [],
          mergeReady: true,
          blockingReasons: [],
        }),
      mergePr: vi.fn(async () => {
        throw mergeError;
      }),
    };

    await expect(
      processPullRequestMergeTask(
        store as never,
        "/repo",
        task.id,
        github as never,
        () => undefined,
      ),
    ).rejects.toThrow(mergeError.message);

    expect(github.mergePr).toHaveBeenCalledWith({ number: 125, method: "squash" });
    expect(github.getPrMergeStatus).toHaveBeenCalledTimes(2);
    expect(store.updatePrInfo).not.toHaveBeenCalledWith("FN-9105", expect.objectContaining({ status: "merged" }));
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("rethrows the original merge error when the post-failure refresh also fails", async () => {
    const task: MockTask = {
      id: "FN-9106",
      title: "test",
      description: "desc",
      column: "in-review",
      prInfo: {
        number: 126,
        url: "https://github.com/x/y/pull/126",
        status: "open",
        headBranch: "fusion/fn-9106",
        baseBranch: "main",
      },
    };
    const store = makeStore(task);
    const mergeError = new Error("merge command failed");
    const openPr = {
      number: 126,
      url: "https://github.com/x/y/pull/126",
      status: "open" as const,
      headBranch: "fusion/fn-9106",
      baseBranch: "main",
    };
    const github = {
      findPrForBranch: vi.fn(),
      createPr: vi.fn(),
      getPrMergeStatus: vi
        .fn()
        .mockResolvedValueOnce({
          prInfo: openPr,
          reviewDecision: "APPROVED",
          checks: [],
          mergeReady: true,
          blockingReasons: [],
        })
        .mockRejectedValueOnce(new Error("status refresh failed")),
      mergePr: vi.fn(async () => {
        throw mergeError;
      }),
    };

    await expect(
      processPullRequestMergeTask(
        store as never,
        "/repo",
        task.id,
        github as never,
        () => undefined,
      ),
    ).rejects.toThrow(mergeError.message);

    expect(github.mergePr).toHaveBeenCalledWith({ number: 126, method: "squash" });
    expect(github.getPrMergeStatus).toHaveBeenCalledTimes(2);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("preserves PR number/url through create, refresh, and merge completion", async () => {
    const task: MockTask = {
      id: "FN-9103",
      title: "test",
      description: "desc",
      column: "in-review",
    };
    const store = makeStatefulStore(task);

    const createdPr = {
      number: 123,
      url: "https://github.com/x/y/pull/123",
      status: "open" as const,
      headBranch: "fusion/fn-9103",
      baseBranch: "main",
      title: "PR title",
      commentCount: 0,
    };
    const mergedPr = {
      ...createdPr,
      status: "merged" as const,
      commentCount: 2,
    };

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => createdPr),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { ...createdPr, commentCount: 1 },
        reviewDecision: "APPROVED",
        checks: [],
        mergeReady: true,
        blockingReasons: [],
      })),
      mergePr: vi.fn(async () => mergedPr),
    };

    const result = await processPullRequestMergeTask(
      store as never,
      "/repo",
      task.id,
      github as never,
      () => undefined,
    );

    expect(result).toBe("merged");
    const persisted = (store as { _getState: () => MockTask })._getState();
    expect(persisted.column).toBe("done");
    expect(persisted.prInfo?.number).toBe(123);
    expect(persisted.prInfo?.url).toBe("https://github.com/x/y/pull/123");
    expect(store.updatePrInfo).toHaveBeenCalledTimes(3);
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
