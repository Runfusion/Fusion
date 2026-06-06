import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock child_process so we can intercept the `git push -u origin <branch>`
// call that processPullRequestMergeTask issues before createPr.
const execMock = vi.hoisted(() => vi.fn());
// Records raw (file, args[]) tuples for execFile so tests can assert a no-shell
// invocation (Fix #11) — i.e. the branch is a discrete argv entry, not shell-
// interpolated.
const execFileCalls = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>);
vi.mock("node:child_process", () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    try {
      const result = execMock(cmd, opts);
      cb(null, typeof result === "string" ? result : "", "");
    } catch (err) {
      cb(err as Error, "", (err as Error).message);
    }
  },
  execFile: (file: string, args: string[] | undefined, opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    try {
      execFileCalls.push({ file, args: args ?? [] });
      const result = execMock(`${file} ${(args ?? []).join(" ")}`.trim(), opts);
      cb(null, typeof result === "string" ? result : "", "");
    } catch (err) {
      cb(err as Error, "", (err as Error).message);
    }
  },
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    getCurrentRepo: vi.fn(() => ({ owner: "owner", repo: "repo" })),
  };
});

import { activeSessionRegistry } from "@fusion/engine";
import {
  cleanupMergedTaskArtifacts,
  createGroupPrCallback,
  processPullRequestMergeTask,
  getTaskBranchName,
  syncGroupPrCallback,
} from "../task-lifecycle.js";

interface MockTask {
  id: string;
  title: string;
  description: string;
  worktree?: string;
  baseBranch?: string;
  branchContext?: {
    groupId: string;
    source: "planning" | "mission" | "new-task";
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

// `requirePrApproval` MOVED to workflow settings (U4): the CLI now resolves the
// task's EFFECTIVE workflow settings and overlays them onto the project base. So a
// mock store must expose `requirePrApproval` (and any moved key) through the
// effective-settings resolver store surface (`getWorkflowSettingValues` etc.), not
// through `getSettings()`. These stubs make `resolveEffectiveSettings` degrade to
// `builtin:coding` and read the moved value from the stored workflow values.
const MOVED_TEST_KEYS = new Set(["requirePrApproval"]);

function splitMovedSettings(settings: Record<string, unknown>) {
  const projectSettings: Record<string, unknown> = {};
  const workflowValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (MOVED_TEST_KEYS.has(key)) workflowValues[key] = value;
    else projectSettings[key] = value;
  }
  return { projectSettings, workflowValues };
}

function workflowSettingsResolverStubs(workflowValues: Record<string, unknown>) {
  return {
    // No selection → resolver degrades to builtin:coding, whose declarations carry
    // the moved-key catalog; the stored values below override the declaration default.
    getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
    getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
    getWorkflowSettingValues: vi.fn().mockReturnValue(workflowValues),
    getWorkflowSettingsProjectId: vi.fn().mockReturnValue("test-project"),
  };
}

function makeStore(task: MockTask, settings: Record<string, unknown> = {}) {
  const emitter = new EventEmitter();
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const { projectSettings, workflowValues } = splitMovedSettings(settings);
  return Object.assign(emitter, {
    getTask: vi.fn().mockResolvedValue(task),
    getSettings: vi.fn().mockResolvedValue({ ...projectSettings }),
    updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
    }),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn(async (_id: string, column: string) => ({ ...task, column })),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getActiveMergingTask: vi.fn().mockReturnValue(null),
    getBranchGroup: vi.fn().mockReturnValue(null),
    updateBranchGroup: vi.fn(),
    listTasksByBranchGroup: vi.fn().mockResolvedValue([]),
    ...workflowSettingsResolverStubs(workflowValues),
    _updates: updates,
  });
}

function makeStatefulStore(task: MockTask, settings: Record<string, unknown> = {}) {
  const emitter = new EventEmitter();
  let state = structuredClone(task);
  const { projectSettings, workflowValues } = splitMovedSettings(settings);
  return Object.assign(emitter, {
    getTask: vi.fn(async () => structuredClone(state)),
    getSettings: vi.fn().mockResolvedValue({ ...projectSettings }),
    ...workflowSettingsResolverStubs(workflowValues),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      state = { ...state, ...patch };
    }),
    updatePrInfo: vi.fn(async (_id: string, prInfo: MockTask["prInfo"]) => {
      state = { ...state, prInfo: prInfo ?? undefined };
      return structuredClone(state);
    }),
    moveTask: vi.fn(async (_id: string, column: string) => {
      state = { ...state, column };
      return structuredClone(state);
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getActiveMergingTask: vi.fn().mockReturnValue(null),
    getBranchGroup: vi.fn().mockReturnValue(null),
    updateBranchGroup: vi.fn(),
    listTasksByBranchGroup: vi.fn().mockResolvedValue([]),
    _getState: () => state,
  });
}

describe("processPullRequestMergeTask", () => {
  beforeEach(() => {
    execMock.mockReset();
    execFileCalls.length = 0;
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
    // No-shell invocation (Fix #11): the branch is now a discrete execFile arg, so
    // there are no surrounding quotes in the recorded command string.
    const pushIdx = callOrder.findIndex((c) => c === `exec:git push -u origin ${branch}`);
    const findIdx = callOrder.indexOf("findPrForBranch");
    const createIdx = callOrder.indexOf("createPr");
    expect(pushIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(findIdx);
    expect(pushIdx).toBeLessThan(createIdx);

    // The push goes through execFile with the branch as a separate argv entry —
    // never interpolated into a shell command — so a crafted branch name can't
    // execute a subshell.
    const pushCall = execFileCalls.find((c) => c.file === "git" && c.args[0] === "push");
    expect(pushCall).toBeDefined();
    expect(pushCall!.args).toEqual(["push", "-u", "origin", branch]);
  });

  it("creates shared-group PR from integration branch into default branch", async () => {
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
    const store = makeStore(task, { baseBranch: "main" });
    (store.getBranchGroup as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "BG-1",
      sourceType: "planning",
      sourceId: "planning:abc",
      branchName: "fusion/groups/planning-abc",
      autoMerge: false,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    (store.listTasksByBranchGroup as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-list --count")) return "1\n";
      return "";
    });

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => ({
        number: 7,
        url: "https://github.com/x/y/pull/7",
        status: "open" as const,
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

    await processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined);

    expect(github.createPr).toHaveBeenCalledWith(expect.objectContaining({
      head: "fusion/groups/planning-abc",
      base: "main",
    }));
    expect(store.updateBranchGroup).toHaveBeenCalledWith("BG-1", expect.objectContaining({
      prNumber: 7,
      prUrl: "https://github.com/x/y/pull/7",
      prState: "open",
    }));
  });

  it("routes shared branch-group members through group PR flow", async () => {
    const task: MockTask = {
      id: "FN-9010",
      title: "group member",
      description: "desc",
      column: "in-review",
      branchContext: {
        groupId: "BG-1",
        source: "planning",
        assignmentMode: "shared",
      },
    };
    const store = makeStore(task);
    (store.getBranchGroup as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "BG-1",
      sourceType: "planning",
      sourceId: "P-1",
      branchName: "fusion/groups/p-1",
      autoMerge: false,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    (store.listTasksByBranchGroup as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-list --count")) return "1\n";
      return "";
    });

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => ({ number: 13, url: "https://github.com/x/y/pull/13", status: "open" as const })),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 13, status: "open" as const, url: "https://github.com/x/y/pull/13" },
        reviewDecision: null,
        checks: [],
        mergeReady: false,
        blockingReasons: [],
      })),
      mergePr: vi.fn(),
    };

    await processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined);

    expect(github.createPr).toHaveBeenCalledWith(expect.objectContaining({ head: "fusion/groups/p-1" }));
    expect(store.listTasksByBranchGroup).toHaveBeenCalledWith("BG-1");
  });

  it("falls back to per-task path when shared group row is missing", async () => {
    const task: MockTask = {
      id: "FN-9011",
      title: "group member",
      description: "desc",
      column: "in-review",
      branchContext: {
        groupId: "BG-missing",
        source: "planning",
        assignmentMode: "shared",
      },
    };
    const store = makeStore(task);
    execMock.mockImplementation(() => "");

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => ({
        number: 14,
        url: "https://github.com/x/y/pull/14",
        status: "open" as const,
        headBranch: getTaskBranchName(task.id),
      })),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 14, status: "open" as const, url: "https://github.com/x/y/pull/14" },
        reviewDecision: null,
        checks: [],
        mergeReady: false,
        blockingReasons: [],
      })),
      mergePr: vi.fn(),
    };

    await processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined);

    expect(github.createPr).toHaveBeenCalledWith(expect.objectContaining({ head: getTaskBranchName(task.id) }));
  });

  it("does not create duplicate group PR when branch-group PR already exists", async () => {
    const task: MockTask = {
      id: "FN-9012",
      title: "group member",
      description: "desc",
      column: "in-review",
      branchContext: {
        groupId: "BG-2",
        source: "planning",
        assignmentMode: "shared",
      },
    };
    const store = makeStore(task);
    (store.getBranchGroup as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "BG-2",
      sourceType: "planning",
      sourceId: "P-2",
      branchName: "fusion/groups/p-2",
      autoMerge: false,
      prState: "open",
      prNumber: 22,
      prUrl: "https://github.com/x/y/pull/22",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    (store.listTasksByBranchGroup as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-list --count")) return "1\n";
      return "";
    });

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 22, status: "open" as const, url: "https://github.com/x/y/pull/22" },
        reviewDecision: null,
        checks: [],
        mergeReady: false,
        blockingReasons: [],
      })),
      mergePr: vi.fn(),
    };

    await processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined);

    expect(github.createPr).not.toHaveBeenCalled();
    expect(github.getPrMergeStatus).toHaveBeenCalledWith("main", "fusion/groups/p-2", 22);
    expect(store.updateBranchGroup).toHaveBeenCalledWith("BG-2", expect.objectContaining({
      prNumber: 22,
      prUrl: "https://github.com/x/y/pull/22",
      prState: "open",
    }));
  });

  it("finalizes branch group and member tasks when shared group PR is already merged", async () => {
    const taskA: MockTask = {
      id: "FN-9015",
      title: "A",
      description: "desc A",
      column: "in-review",
      branchContext: { groupId: "BG-4", source: "planning", assignmentMode: "shared" },
      worktree: "/tmp/a",
    };
    const taskB: MockTask = {
      id: "FN-9016",
      title: "B",
      description: "desc B",
      column: "in-review",
      branchContext: { groupId: "BG-4", source: "planning", assignmentMode: "shared" },
      worktree: "/tmp/b",
    };
    const store = makeStore(taskA);
    (store.getTask as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => (id === taskB.id ? taskB : taskA));
    (store.getBranchGroup as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "BG-4",
      sourceType: "planning",
      sourceId: "P-4",
      branchName: "fusion/groups/p-4",
      autoMerge: false,
      prState: "open",
      prNumber: 24,
      prUrl: "https://github.com/x/y/pull/24",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    (store.listTasksByBranchGroup as ReturnType<typeof vi.fn>).mockResolvedValue([taskA, taskB]);
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-list --count")) return "1\n";
      return "";
    });

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 24, status: "merged" as const, url: "https://github.com/x/y/pull/24" },
        reviewDecision: "APPROVED" as const,
        checks: [],
        mergeReady: true,
        blockingReasons: [],
      })),
      mergePr: vi.fn(),
    };

    const result = await processPullRequestMergeTask(store as never, "/repo", taskA.id, github as never, () => undefined);

    expect(result).toBe("merged");
    expect(store.moveTask).toHaveBeenCalledWith(taskA.id, "done");
    expect(store.moveTask).toHaveBeenCalledWith(taskB.id, "done");
    expect(store.updateBranchGroup).toHaveBeenCalledWith("BG-4", expect.objectContaining({
      status: "finalized",
      prState: "merged",
    }));
  });

  it("excludes empty member branches from group PR body", async () => {
    const taskA: MockTask = {
      id: "FN-9013",
      title: "A",
      description: "desc A",
      column: "in-review",
      branchContext: { groupId: "BG-3", source: "planning", assignmentMode: "shared" },
    };
    const taskB: MockTask = {
      id: "FN-9014",
      title: "B",
      description: "desc B",
      column: "in-review",
      branchContext: { groupId: "BG-3", source: "planning", assignmentMode: "shared" },
    };
    const store = makeStore(taskA);
    (store.getBranchGroup as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "BG-3",
      sourceType: "planning",
      sourceId: "P-3",
      branchName: "fusion/groups/p-3",
      autoMerge: false,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    (store.listTasksByBranchGroup as ReturnType<typeof vi.fn>).mockResolvedValue([taskA, taskB]);
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-list --count") && cmd.includes("fn-9014")) return "0\n";
      if (cmd.includes("rev-list --count")) return "1\n";
      return "";
    });

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => ({ number: 23, url: "https://github.com/x/y/pull/23", status: "open" as const })),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 23, status: "open" as const, url: "https://github.com/x/y/pull/23" },
        reviewDecision: null,
        checks: [],
        mergeReady: false,
        blockingReasons: [],
      })),
      mergePr: vi.fn(),
    };

    await processPullRequestMergeTask(store as never, "/repo", taskA.id, github as never, () => undefined);

    expect(github.createPr).toHaveBeenCalledTimes(1);
    expect(github.createPr).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining("FN-9013"),
    }));
    expect(github.createPr).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.not.stringContaining("FN-9014"),
    }));
  });

  it("keeps per-task-derived members on the project default PR base", async () => {
    const task: MockTask = {
      id: "FN-9002",
      title: "test",
      description: "desc",
      column: "in-review",
      branchContext: {
        groupId: "planning:abc",
        source: "planning",
        assignmentMode: "per-task-derived",
      },
    };
    const store = makeStore(task, { baseBranch: "main" });
    execMock.mockImplementation(() => "");

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => ({
        number: 7,
        url: "https://github.com/x/y/pull/7",
        status: "open" as const,
        headBranch: getTaskBranchName(task.id),
        baseBranch: "main",
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
      base: "main",
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

    const mergedEvents: unknown[] = [];
    store.on("task:merged", (result) => {
      mergedEvents.push(result);
    });

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
    expect(mergedEvents).toHaveLength(1);
    expect(mergedEvents[0]).toEqual(
      expect.objectContaining({
        merged: true,
        task: expect.objectContaining({ id: task.id, column: "done" }),
      }),
    );
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

describe("cleanupMergedTaskArtifacts FN-5455", () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockReturnValue("");
    activeSessionRegistry.clear();
  });

  afterEach(() => {
    activeSessionRegistry.clear();
  });

  it("FN-5455: releases pool lease before removing worktree and deleting branch", async () => {
    const pool = { release: vi.fn() };
    await cleanupMergedTaskArtifacts("/repo", { id: "FN-5455-A", worktree: "/repo/wt" } as never, { pool } as never);
    expect(pool.release).toHaveBeenCalledWith("/repo/wt", "FN-5455-A");
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('git worktree remove "/repo/wt" --force'), expect.any(Object));
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('git branch -d "fusion/fn-5455-a"'), expect.any(Object));
  });

  it("FN-5455: pool omitted keeps backward-compatible cleanup behavior", async () => {
    await cleanupMergedTaskArtifacts("/repo", { id: "FN-5455-B", worktree: "/repo/wt-b" } as never);
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('git worktree remove "/repo/wt-b" --force'), expect.any(Object));
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('git branch -d "fusion/fn-5455-b"'), expect.any(Object));
  });

  it("FN-5455: undefined worktree skips pool interaction and worktree removal", async () => {
    const pool = { release: vi.fn() };
    await cleanupMergedTaskArtifacts("/repo", { id: "FN-5455-C", worktree: undefined } as never, { pool } as never);
    expect(pool.release).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining("git worktree remove"), expect.anything());
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('git branch -d "fusion/fn-5455-c"'), expect.any(Object));
  });

  it("FN-5455: release errors are swallowed and cleanup continues", async () => {
    const pool = { release: vi.fn(() => { throw new Error("boom"); }) };
    await expect(
      cleanupMergedTaskArtifacts("/repo", { id: "FN-5455-D", worktree: "/repo/wt-d" } as never, { pool } as never),
    ).resolves.toBeUndefined();
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('git worktree remove "/repo/wt-d" --force'), expect.any(Object));
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('git branch -d "fusion/fn-5455-d"'), expect.any(Object));
  });

  it("FN-5872: cleanup clears active-session registry entry", async () => {
    const worktree = "/repo/wt-fn-5872";
    activeSessionRegistry.registerPath(worktree, {
      taskId: "FN-5872-A",
      kind: "executor",
      ownerKey: "FN-5872-A",
    });

    expect(activeSessionRegistry.lookupByPath(worktree)).not.toBeNull();

    await cleanupMergedTaskArtifacts("/repo", { id: "FN-5872-A", worktree } as never);

    expect(activeSessionRegistry.lookupByPath(worktree)).toBeNull();
  });

  it("FN-5872: cleanup remains a no-throw best-effort when no registry entry exists", async () => {
    await expect(
      cleanupMergedTaskArtifacts("/repo", { id: "FN-5872-B", worktree: "/repo/wt-fn-5872-missing" } as never),
    ).resolves.toBeUndefined();
  });
});

describe("syncGroupPrCallback (U6)", () => {
  const group = {
    id: "BG-1",
    branchName: "fusion/groups/x",
    sourceType: "planning" as const,
    sourceId: "PS-1",
    prNumber: 42,
    prUrl: "https://github.com/owner/repo/pull/42",
    prState: "open" as const,
    status: "open" as const,
    autoMerge: false,
    createdAt: 0,
    updatedAt: 0,
  };
  const members = [
    { id: "FN-A", title: "Alpha" },
    { id: "FN-B", title: "Beta" },
  ] as never[];

  it("edits the PR body when the PR is open and returns the persisted shape", async () => {
    const github = {
      getPrStatus: vi.fn(async () => ({ number: 42, url: "https://github.com/owner/repo/pull/42", status: "open", title: "T", headBranch: "h", baseBranch: "main", commentCount: 0 })),
      updatePr: vi.fn(async () => ({ number: 42, url: "https://github.com/owner/repo/pull/42", status: "open", title: "T2", headBranch: "h", baseBranch: "main", commentCount: 0 })),
    };
    const sync = syncGroupPrCallback(github as never);
    const result = await sync({ cwd: "/tmp/project", group: group as never, members });
    expect(result).toEqual({ prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42", prState: "open" });
    expect(github.updatePr).toHaveBeenCalledTimes(1);
    // T4: owner/repo must be forwarded so multi-project daemons target the
    // resolved per-project repo, not process.cwd().
    expect(github.updatePr).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "owner", repo: "repo", number: 42 }),
    );
    const body = (github.updatePr.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Completion: 0/2 landed");
    expect(body).toContain("FN-A: Alpha");
  });

  it("reconciles (does not edit) when the PR is closed out-of-band", async () => {
    const github = {
      getPrStatus: vi.fn(async () => ({ number: 42, url: "https://github.com/owner/repo/pull/42", status: "closed", title: "T", headBranch: "h", baseBranch: "main", commentCount: 0 })),
      updatePr: vi.fn(),
    };
    const sync = syncGroupPrCallback(github as never);
    const result = await sync({ cwd: "/tmp/project", group: group as never, members });
    expect(result.prState).toBe("closed");
    expect(github.updatePr).not.toHaveBeenCalled();
  });

  it("throws when the group has no persisted prNumber", async () => {
    const github = { getPrStatus: vi.fn(), updatePr: vi.fn() };
    const sync = syncGroupPrCallback(github as never);
    await expect(sync({ cwd: "/tmp/project", group: { ...group, prNumber: undefined } as never, members })).rejects.toThrow(/no persisted prNumber/);
  });
});

describe("createGroupPrCallback", () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockImplementation(() => "");
  });

  const group = {
    id: "BG-1",
    sourceType: "planning" as const,
    sourceId: "P-1",
    branchName: "fusion/groups/p-1",
    autoMerge: false,
    prState: "none" as const,
    status: "open" as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const members = [{ id: "FN-A", title: "Alpha", description: "a", column: "in-review" } as never];

  it("queries only OPEN PRs for the head branch (does not reuse terminal PRs)", async () => {
    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => ({
        number: 99,
        url: "https://github.com/owner/repo/pull/99",
        status: "open" as const,
      })),
    };

    const callback = createGroupPrCallback(github as never);
    await callback({
      cwd: "/repo",
      group: group as never,
      members,
      headBranch: group.branchName,
      baseBranch: "main",
    });

    expect(github.findPrForBranch).toHaveBeenCalledWith({ head: group.branchName, state: "open" });
  });

  it("does not reuse a closed PR from a prior group — creates a fresh one", async () => {
    // With state:"open", findPrForBranch returns null for a head whose only PR
    // is closed/merged, so the create path runs instead of resurrecting the
    // terminal PR (which would poison the newly promoted group's prState).
    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => ({
        number: 123,
        url: "https://github.com/owner/repo/pull/123",
        status: "open" as const,
      })),
    };

    const callback = createGroupPrCallback(github as never);
    const result = await callback({
      cwd: "/repo",
      group: group as never,
      members,
      headBranch: group.branchName,
      baseBranch: "main",
    });

    expect(github.findPrForBranch).toHaveBeenCalledWith({ head: group.branchName, state: "open" });
    expect(github.createPr).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      prNumber: 123,
      prUrl: "https://github.com/owner/repo/pull/123",
      prState: "open",
    });
  });
});

