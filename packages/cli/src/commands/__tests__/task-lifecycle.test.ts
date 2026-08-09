import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock child_process so we can intercept the `git push -u origin <branch>`
// call that processPullRequestMergeTask issues before createPr.
const execMock = vi.hoisted(() => vi.fn());
// Records raw (file, args[], cwd) tuples for execFile so tests can assert a
// no-shell invocation (Fix #11) — i.e. the branch is a discrete argv entry, not
// shell-interpolated — and that git ops target the task worktree cwd (gh-4).
const execFileCalls = vi.hoisted(
  () => [] as Array<{ file: string; args: string[]; cwd: string | undefined }>,
);
const refreshFixture = vi.hoisted(() => ({ next: 0, branch: "fusion/fn-9601" }));
const createIngestedCheckResolverMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    realpath: vi.fn(async (path: string) => path),
    mkdir: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async (prefix: string) => `${prefix}${++refreshFixture.next}`),
  };
});
function defaultGitOutput(command: string, cwd?: string): string {
  if (command.includes("worktree list --porcelain")) return "";
  if (command.includes(" config --get branch.")) return "origin\n";
  if (command.endsWith(" remote")) return "origin\n";
  if (command.includes("rev-parse --show-toplevel")) return cwd ?? "";
  if (command.includes("symbolic-ref -q HEAD")) return "refs/heads/fusion/fn-9601\n";
  if (command.includes("rev-parse HEAD")) return "1111111111111111111111111111111111111111\n";
  if (command.includes("rev-parse --verify refs/heads/")) return "0000000000000000000000000000000000000000\n";
  if (command.includes("ls-remote origin refs/heads/")) return "1111111111111111111111111111111111111111\trefs/heads/test\n";
  return "";
}
vi.mock("node:child_process", () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    try {
      const result = execMock(cmd, opts);
      cb(null, typeof result === "string" && result ? result : defaultGitOutput(cmd, (opts as { cwd?: string } | undefined)?.cwd), "");
    } catch (err) {
      cb(err as Error, "", (err as Error).message);
    }
  },
  execFile: (file: string, args: string[] | undefined, opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    try {
      execFileCalls.push({ file, args: args ?? [], cwd: (opts as { cwd?: string } | undefined)?.cwd });
      if (file === "git" && args?.[0] === "worktree" && args[1] === "add") {
        const ref = args.at(-1);
        if (ref?.startsWith("refs/heads/")) refreshFixture.branch = ref.slice("refs/heads/".length);
        else if (ref?.startsWith("fusion/")) refreshFixture.branch = ref;
      }
      const command = `${file} ${(args ?? []).join(" ")}`.trim();
      const result = execMock(command, opts);
      const output = file === "git" && args?.[0] === "symbolic-ref"
        ? `refs/heads/${refreshFixture.branch}\n`
        : typeof result === "string" && result ? result : defaultGitOutput(command, (opts as { cwd?: string } | undefined)?.cwd);
      cb(null, output, "");
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
    getPushRepo: vi.fn(() => ({ owner: "owner", repo: "repo" })),
    acquireWorktreePathReservation: vi.fn(async (input: { canonicalPath: string }) => ({
      canonicalPath: input.canonicalPath,
      state: "held" as const,
      release: vi.fn(async () => undefined),
      quarantine: vi.fn(async () => undefined),
    })),
    createIngestedCheckResolver: createIngestedCheckResolverMock,
  };
});

import { acquireWorktreePathReservation, createIngestedCheckResolver, getCurrentRepo, getPushRepo } from "@fusion/core";
import { activeSessionRegistry } from "@fusion/engine";
import {
  cleanupMergedTaskArtifacts,
  createGroupPrCallback,
  createPrNodeGithubOps,
  processPullRequestMergeTask,
  refreshAutomatedPrHead,
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
    vi.mocked(getCurrentRepo).mockReturnValue({ owner: "owner", repo: "repo" });
    // Same-repo default: push owner matches fetch owner so heads stay unqualified.
    vi.mocked(getPushRepo).mockReturnValue({ owner: "owner", repo: "repo" });
    vi.mocked(createIngestedCheckResolver).mockReset().mockReturnValue(undefined);
  });

  describe("central-install repo threading (gh-4)", () => {
    // FNXC:PrMergeAutoMerge 2026-07-17-19:18 (gh-4):
    // Simulate a centrally-installed multi-project daemon: process.cwd() is NOT
    // a git repo, so cwd-less getCurrentRepo() returns null; only the
    // per-project cwd resolves. Any PR call that relies on the client's
    // process-cwd fallback would blow up with "Could not determine repository".
    beforeEach(() => {
      vi.mocked(getCurrentRepo).mockImplementation(((cwd?: string) =>
        cwd ? { owner: "central-owner", repo: "central-repo" } : null) as never);
      vi.mocked(getPushRepo).mockReturnValue({ owner: "central-owner", repo: "central-repo" });
    });

    it("threads explicit owner/repo into findPrForBranch, createPr, and mergePr on the per-task path", async () => {
      const task: MockTask = { id: "FN-9401", title: "t", description: "d", column: "in-review" };
      const branch = getTaskBranchName(task.id);
      const store = makeStatefulStore(task);
      execMock.mockReturnValue("");

      const github = {
        findPrForBranch: vi.fn(async () => null),
        createPr: vi.fn(async () => ({
          number: 77,
          url: "https://github.com/central-owner/central-repo/pull/77",
          status: "open" as const,
          headBranch: branch,
          baseBranch: "main",
        })),
        getPrMergeStatus: vi.fn(async () => ({
          prInfo: {
            number: 77,
            url: "https://github.com/central-owner/central-repo/pull/77",
            status: "open" as const,
          },
          reviewDecision: null,
          checks: [],
          mergeReady: true,
          blockingReasons: [],
        })),
        mergePr: vi.fn(async () => ({
          number: 77,
          url: "https://github.com/central-owner/central-repo/pull/77",
          status: "merged" as const,
        })),
      };

      const result = await processPullRequestMergeTask(
        store as never,
        "/projects/repo-a",
        task.id,
        github as never,
        () => undefined,
      );

      expect(result).toBe("merged");
      expect(github.findPrForBranch).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "central-owner", repo: "central-repo", head: branch }),
      );
      expect(github.createPr).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "central-owner", repo: "central-repo", head: branch }),
      );
      expect(github.mergePr).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "central-owner", repo: "central-repo", number: 77, method: "squash" }),
      );
    });

    it("threads explicit owner/repo into findPrForBranch, createPr, and mergePr on the shared-branch-group path", async () => {
      const task: MockTask = {
        id: "FN-9402",
        title: "t",
        description: "d",
        column: "in-review",
        branchContext: { groupId: "planning:g4", source: "planning", assignmentMode: "shared" },
      };
      const store = makeStore(task, { baseBranch: "main", requiredChecks: [" build ", "build", ""] });
      (store.getBranchGroup as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "BG-4",
        sourceType: "planning",
        sourceId: "planning:g4",
        branchName: "fusion/groups/planning-g4",
        autoMerge: true,
        prState: "none",
        status: "open",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      (store.listTasksByBranchGroup as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
      execMock.mockImplementation((cmd: string) => (cmd.includes("rev-list --count") ? "1\n" : ""));

      const github = {
        findPrForBranch: vi.fn(async () => null),
        createPr: vi.fn(async () => ({
          number: 88,
          url: "https://github.com/central-owner/central-repo/pull/88",
          status: "open" as const,
          headBranch: "fusion/groups/planning-g4",
          baseBranch: "main",
        })),
        getPrMergeStatus: vi.fn(async () => ({
          prInfo: {
            number: 88,
            url: "https://github.com/central-owner/central-repo/pull/88",
            status: "open" as const,
          },
          reviewDecision: null,
          checks: [],
          mergeReady: true,
          blockingReasons: [],
        })),
        mergePr: vi.fn(async () => ({
          number: 88,
          url: "https://github.com/central-owner/central-repo/pull/88",
          status: "merged" as const,
        })),
      };

      const result = await processPullRequestMergeTask(
        store as never,
        "/projects/repo-a",
        task.id,
        github as never,
        () => undefined,
      );

      expect(result).toBe("merged");
      expect(github.findPrForBranch).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "central-owner", repo: "central-repo", head: "fusion/groups/planning-g4" }),
      );
      expect(github.createPr).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "central-owner", repo: "central-repo", head: "fusion/groups/planning-g4" }),
      );
      expect(github.mergePr).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "central-owner", repo: "central-repo", number: 88, method: "squash" }),
      );
      expect(github.getPrMergeStatus).toHaveBeenCalledWith(
        "central-owner", "central-repo", 88, { requiredCheckNames: ["build"] },
      );
    });
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

  it("holds a branch-protected shared-group PR without calling mergePr", async () => {
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
        prInfo: { number: 22, status: "open" as const, url: "https://github.com/x/y/pull/22", mergeable: "blocked" as const },
        reviewDecision: "REVIEW_REQUIRED",
        checks: [],
        mergeReady: false,
        blockingReasons: ["PR mergeability is blocked"],
      })),
      mergePr: vi.fn(),
    };

    await processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined);

    expect(github.createPr).not.toHaveBeenCalled();
    expect(github.getPrMergeStatus).toHaveBeenCalledWith("owner", "repo", 22);
    expect(github.mergePr).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(task.id, { status: "awaiting-pr-checks" });
    expect(store.updateBranchGroup).toHaveBeenCalledWith("BG-2", expect.objectContaining({
      prNumber: 22,
      prUrl: "https://github.com/x/y/pull/22",
      prState: "open",
    }));
  });

  it("rejects before PR status checks when the project repository cannot be resolved", async () => {
    vi.mocked(getCurrentRepo).mockReturnValueOnce(null);
    const task: MockTask = {
      id: "FN-7133",
      title: "test",
      description: "desc",
      column: "in-review",
      prInfo: {
        number: 7133,
        url: "https://github.com/x/y/pull/7133",
        status: "open",
        headBranch: "fusion/fn-7133",
        baseBranch: "main",
      },
    };
    const store = makeStore(task);
    const github = {
      findPrForBranch: vi.fn(),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn(),
      mergePr: vi.fn(),
    };

    await expect(
      processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined),
    ).rejects.toThrow("processPullRequestMergeTask: could not determine repository");

    expect(github.getPrMergeStatus).not.toHaveBeenCalled();
    expect(github.findPrForBranch).not.toHaveBeenCalled();
    expect(github.createPr).not.toHaveBeenCalled();
  });

  // FNXC:Workspace 2026-07-05-00:00 (FN-7610, defense-in-depth):
  // A workspace-mode task (non-empty workspaceWorktrees) must never reach
  // getCurrentRepo here — the engine merge dispatch is the primary fix that
  // routes workspace tasks around this function entirely, but if a future
  // caller forgets that guard, this must fail with the named
  // WorkspaceTaskMergeError BEFORE getCurrentRepo is even called (never the
  // generic "could not determine repository").
  it("rejects with the named WorkspaceTaskMergeError for a workspace-mode task, before resolving the repository", async () => {
    const getCurrentRepoMock = vi.mocked(getCurrentRepo);
    getCurrentRepoMock.mockClear();
    const task: MockTask & { workspaceWorktrees: Record<string, unknown> } = {
      id: "FN-7610-WS",
      title: "test",
      description: "desc",
      column: "in-review",
      workspaceWorktrees: {
        "repo-a": { worktreePath: "/tmp/a", branch: "fusion/fn-7610-ws-a" },
      },
    };
    const store = makeStore(task as never);
    const github = {
      findPrForBranch: vi.fn(),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn(),
      mergePr: vi.fn(),
    };

    const rejection = processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined);
    await expect(rejection).rejects.toMatchObject({ name: "WorkspaceTaskMergeError" });
    await expect(rejection).rejects.not.toThrow("could not determine repository");

    expect(getCurrentRepoMock).not.toHaveBeenCalled();
    expect(github.getPrMergeStatus).not.toHaveBeenCalled();
    expect(github.findPrForBranch).not.toHaveBeenCalled();
    expect(github.createPr).not.toHaveBeenCalled();
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
    expect(github.getPrMergeStatus).toHaveBeenCalledWith("owner", "repo", 7);
  });

  it("counts a conflicting stale-base PR against mergeRetries so the stall escape fires", async () => {
    const task: MockTask = {
      id: "FN-9020",
      title: "test",
      description: "desc",
      column: "in-review",
      mergeRetries: 1,
    };
    const branch = getTaskBranchName(task.id);
    const store = makeStore(task);
    execMock.mockImplementation(() => "");

    const existingPr = { number: 9, url: "https://github.com/x/y/pull/9", status: "open" as const, headBranch: branch, baseBranch: "main" };
    const github = {
      findPrForBranch: vi.fn(async () => existingPr),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { ...existingPr, mergeable: "conflicting" as const },
        reviewDecision: null,
        checks: [],
        mergeReady: false,
        blockingReasons: [],
      })),
      mergePr: vi.fn(),
    };

    const result = await processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined);

    expect(result).toBe("waiting");
    expect(store.updateTask).toHaveBeenCalledWith(task.id, {
      status: "awaiting-pr-checks",
      mergeRetries: 2,
    });
  });

  it("holds a branch-protected review-required PR without a merge attempt or conflict retry", async () => {
    const task: MockTask = {
      id: "FN-9021",
      title: "test",
      description: "desc",
      column: "in-review",
      mergeRetries: 1,
    };
    const branch = getTaskBranchName(task.id);
    const store = makeStore(task);
    execMock.mockImplementation(() => "");

    const existingPr = { number: 10, url: "https://github.com/x/y/pull/10", status: "open" as const, headBranch: branch, baseBranch: "main" };
    const github = {
      findPrForBranch: vi.fn(async () => existingPr),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { ...existingPr, mergeable: "blocked" as const },
        reviewDecision: "REVIEW_REQUIRED",
        checks: [],
        mergeReady: false,
        blockingReasons: ["PR mergeability is blocked"],
      })),
      mergePr: vi.fn(),
    };

    const result = await processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined);

    expect(result).toBe("waiting");
    expect(store.updateTask).toHaveBeenCalledWith(task.id, { status: "awaiting-pr-checks" });
    expect(github.mergePr).not.toHaveBeenCalled();
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

  it("finalizes no-delta branches as a no-op done instead of failing", async () => {
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
      status: null,
      mergeRetries: 0,
    });
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "done");
    expect(store.updateTask).not.toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: "failed" }),
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
      mergeRetries: 2,
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
    expect(github.mergePr).toHaveBeenCalledWith({ owner: "owner", repo: "repo", number: 124, method: "squash", expectedHeadOid: "1111111111111111111111111111111111111111" });
    expect(github.getPrMergeStatus).toHaveBeenCalledTimes(2);
    expect(github.getPrMergeStatus).toHaveBeenNthCalledWith(1, "owner", "repo", 124);
    expect(github.getPrMergeStatus).toHaveBeenNthCalledWith(2, "owner", "repo", 124);
    expect(store.updatePrInfo).toHaveBeenLastCalledWith("FN-9104", expect.objectContaining({ status: "merged" }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-9104", { mergeRetries: 0 });
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

    expect(github.mergePr).toHaveBeenCalledWith({ owner: "owner", repo: "repo", number: 125, method: "squash", expectedHeadOid: "1111111111111111111111111111111111111111" });
    expect(github.getPrMergeStatus).toHaveBeenCalledTimes(2);
    expect(store.updatePrInfo).not.toHaveBeenCalledWith("FN-9105", expect.objectContaining({ status: "merged" }));
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("reports a refreshed blocked review as policy rather than a conflict", async () => {
    const task: MockTask = {
      id: "FN-9105-policy",
      title: "test",
      description: "desc",
      column: "in-review",
      prInfo: { number: 125, url: "https://github.com/x/y/pull/125", status: "open", headBranch: "fusion/fn-9105", baseBranch: "main" },
    };
    const store = makeStore(task);
    const openPr = { ...task.prInfo };
    const github = {
      findPrForBranch: vi.fn(),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn()
        .mockResolvedValueOnce({ prInfo: openPr, reviewDecision: "APPROVED", checks: [], mergeReady: true, blockingReasons: [] })
        .mockResolvedValueOnce({ prInfo: { ...openPr, mergeable: "blocked" }, reviewDecision: "REVIEW_REQUIRED", checks: [], mergeReady: false, blockingReasons: [] }),
      mergePr: vi.fn(async () => { throw new Error("Pull request is not mergeable"); }),
    };

    await expect(processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined))
      .rejects.toThrow("blocked by branch protection: review approval is required");
    expect(store.updatePrInfo).toHaveBeenLastCalledWith(task.id, expect.objectContaining({ status: "open" }));
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("reports refreshed required checks as a policy block", async () => {
    const task: MockTask = {
      id: "FN-9105-checks",
      title: "test",
      description: "desc",
      column: "in-review",
      prInfo: { number: 126, url: "https://github.com/x/y/pull/126", status: "open", headBranch: "fusion/fn-9105", baseBranch: "main" },
    };
    const store = makeStore(task);
    const openPr = { ...task.prInfo };
    const github = {
      findPrForBranch: vi.fn(),
      createPr: vi.fn(),
      getPrMergeStatus: vi.fn()
        .mockResolvedValueOnce({ prInfo: openPr, reviewDecision: "APPROVED", checks: [], mergeReady: true, blockingReasons: [] })
        .mockResolvedValueOnce({
          prInfo: { ...openPr, mergeable: "blocked" },
          reviewDecision: null,
          checks: [],
          mergeReady: false,
          blockingReasons: ["required checks not successful: ci (pending)"],
        }),
      mergePr: vi.fn(async () => { throw new Error("Pull request is not mergeable"); }),
    };

    await expect(processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined))
      .rejects.toThrow("blocked by branch protection: required checks not successful: ci (pending)");
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

    expect(github.mergePr).toHaveBeenCalledWith({ owner: "owner", repo: "repo", number: 126, method: "squash", expectedHeadOid: "1111111111111111111111111111111111111111" });
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
        prInfo: { ...prInfo, mergeable: "clean" as const },
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
      expect(github.mergePr).toHaveBeenCalledWith({ owner: "owner", repo: "repo", number: 100, method: "squash", expectedHeadOid: "1111111111111111111111111111111111111111" });
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
  it("uses a scoped ingested resolver so green proceeds and failure remains awaiting checks", async () => {
    const task: MockTask = {
      id: "FN-9103-event", title: "event checks", description: "desc", column: "in-review",
      prInfo: { number: 101, url: "https://github.com/owner/repo/pull/101", status: "open", headBranch: "fusion/fn-9103-event", baseBranch: "main" },
    };
    const store = makeStore(task, { requiredChecks: ["build"] });
    const layer = { projectId: "project-a" };
    (store as Record<string, unknown>).getAsyncLayer = vi.fn(() => layer);
    const ingestedResolver = vi.fn().mockResolvedValue([
      { repo: "owner/repo", headSha: "abc123", checkName: "build", state: "success", reportedAt: "2026-08-09T00:00:00.000Z" },
    ]);
    vi.mocked(createIngestedCheckResolver).mockReturnValue(ingestedResolver);
    const github = {
      findPrForBranch: vi.fn(), createPr: vi.fn(),
      getPrMergeStatus: vi.fn(async (_owner, _repo, _number, options) => {
        const checks = await options.resolveIngestedChecks({ owner: "owner", repo: "repo", headSha: "abc123" });
        return {
          prInfo: { ...task.prInfo!, mergeable: "clean" as const }, reviewDecision: null, checks: [],
          mergeReady: checks[0]?.state === "success", blockingReasons: checks[0]?.state === "success" ? [] : ["required checks not successful: build (failure)"],
        };
      }),
      mergePr: vi.fn(async () => ({ ...task.prInfo!, status: "merged" as const })),
    };

    expect(await processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined)).toBe("merged");
    expect(createIngestedCheckResolver).toHaveBeenCalledWith(layer);
    expect(github.mergePr).toHaveBeenCalled();

    ingestedResolver.mockResolvedValueOnce([{ repo: "owner/repo", headSha: "abc123", checkName: "build", state: "failure", reportedAt: "2026-08-09T00:00:00.000Z" }]);
    const failedStore = makeStore(task, { requiredChecks: ["build"] });
    (failedStore as Record<string, unknown>).getAsyncLayer = vi.fn(() => layer);
    expect(await processPullRequestMergeTask(failedStore as never, "/repo", task.id, github as never, () => undefined)).toBe("waiting");
    expect((failedStore as { _updates: Array<{ patch: Record<string, unknown> }> })._updates.at(-1)?.patch).toEqual({ status: "awaiting-pr-checks" });
  });

  it("omits the resolver for a layerless or unscoped store", async () => {
    const task: MockTask = { id: "FN-9103-no-layer", title: "checks", description: "desc", column: "in-review", prInfo: { number: 102, url: "https://github.com/owner/repo/pull/102", status: "open" } };
    const store = makeStore(task, { requiredChecks: ["build"] });
    (store as Record<string, unknown>).getAsyncLayer = vi.fn(() => undefined);
    const github = { findPrForBranch: vi.fn(), createPr: vi.fn(), getPrMergeStatus: vi.fn(async () => ({ prInfo: { ...task.prInfo!, mergeable: "clean" as const }, reviewDecision: null, checks: [], mergeReady: false, blockingReasons: ["required check not reported: build"] })), mergePr: vi.fn() };

    await processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined);
    expect(github.getPrMergeStatus).toHaveBeenCalledWith("owner", "repo", 102, { requiredCheckNames: ["build"] });
  });

  it("waits for a configured Fusion check, forwards normalized names, and does not merge", async () => {
    const task: MockTask = {
      id: "FN-9103", title: "test", description: "desc", column: "in-review",
      prInfo: { number: 100, url: "https://github.com/x/y/pull/100", status: "open", headBranch: "fusion/fn-9103", baseBranch: "main" },
    };
    const store = makeStore(task, { requiredChecks: ["  build ", "build", ""] });
    const github = {
      findPrForBranch: vi.fn(), createPr: vi.fn(),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { ...task.prInfo!, mergeable: "clean" as const }, reviewDecision: null, checks: [],
        mergeReady: false, blockingReasons: ["required check not reported: build"],
      })),
      mergePr: vi.fn(),
    };

    const result = await processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined);

    expect(result).toBe("waiting");
    expect(github.getPrMergeStatus).toHaveBeenCalledWith("owner", "repo", 100, { requiredCheckNames: ["build"] });
    expect(github.mergePr).not.toHaveBeenCalled();
    expect((store as { _updates: Array<{ patch: Record<string, unknown> }> })._updates.at(-1)?.patch).toEqual({ status: "awaiting-pr-checks" });
    expect((store as { _updates: Array<{ patch: Record<string, unknown> }> })._updates.some(
      (update) => "mergeRetries" in update.patch,
    )).toBe(false);
  });
  });

  it("arms native auto-merge for a per-task PR without finalizing its open result", async () => {
    const task: MockTask = {
      id: "FN-native-per-task", title: "native", description: "desc", column: "in-review",
      prInfo: { number: 801, url: "https://github.com/owner/repo/pull/801", status: "open", headBranch: "fusion/fn-native-per-task", baseBranch: "main" },
    };
    const store = makeStore(task, { githubNativeAutoMerge: true });
    const github = {
      findPrForBranch: vi.fn(), createPr: vi.fn(),
      getPrMergeStatus: vi.fn().mockResolvedValue({ prInfo: { ...task.prInfo, mergeable: "clean" }, reviewDecision: "APPROVED", checks: [], mergeReady: false, blockingReasons: [] }),
      mergePr: vi.fn().mockResolvedValue({ ...task.prInfo, status: "open" }),
    };

    await expect(processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined)).resolves.toBe("waiting");
    expect(github.mergePr).toHaveBeenCalledWith(expect.objectContaining({ auto: true }));
    expect(github.mergePr).not.toHaveBeenCalledWith(expect.objectContaining({ expectedHeadOid: expect.anything() }));
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("finalizes a per-task PR when GitHub merges native auto-merge synchronously", async () => {
    const task: MockTask = {
      id: "FN-native-per-task-merged", title: "native", description: "desc", column: "in-review",
      prInfo: { number: 803, url: "https://github.com/owner/repo/pull/803", status: "open", headBranch: "fusion/fn-native-per-task-merged", baseBranch: "main" },
    };
    const store = makeStore(task, { githubNativeAutoMerge: true });
    const github = {
      findPrForBranch: vi.fn(), createPr: vi.fn(),
      getPrMergeStatus: vi.fn().mockResolvedValue({ prInfo: { ...task.prInfo, mergeable: "clean" }, reviewDecision: "APPROVED", checks: [], mergeReady: true, blockingReasons: [] }),
      mergePr: vi.fn().mockResolvedValue({ ...task.prInfo, status: "merged" }),
    };

    await expect(processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined)).resolves.toBe("merged");
    expect(github.mergePr).toHaveBeenCalledWith(expect.objectContaining({ auto: true }));
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "done");
  });

  it("keeps the per-task head fence when native auto-merge is disabled", async () => {
    const task: MockTask = {
      id: "FN-legacy-per-task", title: "legacy", description: "desc", column: "in-review",
      prInfo: { number: 804, url: "https://github.com/owner/repo/pull/804", status: "open", headBranch: "fusion/fn-legacy-per-task", baseBranch: "main" },
    };
    const store = makeStore(task);
    const github = {
      findPrForBranch: vi.fn(), createPr: vi.fn(),
      getPrMergeStatus: vi.fn().mockResolvedValue({ prInfo: { ...task.prInfo, mergeable: "clean" }, reviewDecision: "APPROVED", checks: [], mergeReady: true, blockingReasons: [] }),
      mergePr: vi.fn().mockResolvedValue({ ...task.prInfo, status: "merged" }),
    };

    await expect(processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined)).resolves.toBe("merged");
    expect(github.mergePr).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadOid: "1111111111111111111111111111111111111111" }));
    expect(github.mergePr).not.toHaveBeenCalledWith(expect.objectContaining({ auto: true }));
  });

  it("arms native auto-merge for a shared branch group without finalizing its open result", async () => {
    const task: MockTask = {
      id: "FN-native-group", title: "native group", description: "desc", column: "in-review",
      branchContext: { groupId: "BG-native", source: "planning", assignmentMode: "shared" },
    };
    const store = makeStore(task, { githubNativeAutoMerge: true });
    (store.getBranchGroup as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "BG-native", sourceType: "planning", sourceId: "planning:native", branchName: "fusion/groups/native", autoMerge: true,
      prState: "open", prNumber: 802, prUrl: "https://github.com/owner/repo/pull/802", status: "open", createdAt: Date.now(), updatedAt: Date.now(),
    });
    (store.listTasksByBranchGroup as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    execMock.mockImplementation((command: string) => command.includes("rev-list --count") ? "1\n" : "");
    const groupPr = { number: 802, url: "https://github.com/owner/repo/pull/802", status: "open" as const, headBranch: "fusion/groups/native", baseBranch: "main" };
    const github = {
      findPrForBranch: vi.fn(), createPr: vi.fn(),
      getPrMergeStatus: vi.fn().mockResolvedValue({ prInfo: { ...groupPr, mergeable: "clean" }, reviewDecision: "APPROVED", checks: [], mergeReady: false, blockingReasons: [] }),
      mergePr: vi.fn().mockResolvedValue(groupPr),
    };

    await expect(processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined)).resolves.toBe("waiting");
    expect(github.mergePr).toHaveBeenCalledWith(expect.objectContaining({ auto: true }));
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateBranchGroup).toHaveBeenCalledWith("BG-native", expect.objectContaining({ prState: "open" }));
  });

  it("finalizes shared branch members when GitHub merges native auto-merge synchronously", async () => {
    const task: MockTask = {
      id: "FN-native-group-merged", title: "native group", description: "desc", column: "in-review",
      branchContext: { groupId: "BG-native-merged", source: "planning", assignmentMode: "shared" },
    };
    const store = makeStore(task, { githubNativeAutoMerge: true });
    (store.getBranchGroup as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "BG-native-merged", sourceType: "planning", sourceId: "planning:native", branchName: "fusion/groups/native-merged", autoMerge: true,
      prState: "open", prNumber: 805, prUrl: "https://github.com/owner/repo/pull/805", status: "open", createdAt: Date.now(), updatedAt: Date.now(),
    });
    (store.listTasksByBranchGroup as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    execMock.mockImplementation((command: string) => command.includes("rev-list --count") ? "1\n" : "");
    const groupPr = { number: 805, url: "https://github.com/owner/repo/pull/805", status: "open" as const, headBranch: "fusion/groups/native-merged", baseBranch: "main" };
    const github = {
      findPrForBranch: vi.fn(), createPr: vi.fn(),
      getPrMergeStatus: vi.fn().mockResolvedValue({ prInfo: { ...groupPr, mergeable: "clean" }, reviewDecision: "APPROVED", checks: [], mergeReady: true, blockingReasons: [] }),
      mergePr: vi.fn().mockResolvedValue({ ...groupPr, status: "merged" }),
    };

    await expect(processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined)).resolves.toBe("merged");
    expect(github.mergePr).toHaveBeenCalledWith(expect.objectContaining({ auto: true }));
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "done");
    expect(store.updateBranchGroup).toHaveBeenCalledWith("BG-native-merged", expect.objectContaining({ status: "finalized", prState: "merged" }));
  });

  it("keeps the shared branch head fence when native auto-merge is disabled", async () => {
    const task: MockTask = {
      id: "FN-legacy-group", title: "legacy group", description: "desc", column: "in-review",
      branchContext: { groupId: "BG-legacy", source: "planning", assignmentMode: "shared" },
    };
    const store = makeStore(task);
    (store.getBranchGroup as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "BG-legacy", sourceType: "planning", sourceId: "planning:legacy", branchName: "fusion/groups/legacy", autoMerge: true,
      prState: "open", prNumber: 806, prUrl: "https://github.com/owner/repo/pull/806", status: "open", createdAt: Date.now(), updatedAt: Date.now(),
    });
    (store.listTasksByBranchGroup as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
    execMock.mockImplementation((command: string) => command.includes("rev-list --count") ? "1\n" : "");
    const groupPr = { number: 806, url: "https://github.com/owner/repo/pull/806", status: "open" as const, headBranch: "fusion/groups/legacy", baseBranch: "main" };
    const github = {
      findPrForBranch: vi.fn(), createPr: vi.fn(),
      getPrMergeStatus: vi.fn().mockResolvedValue({ prInfo: { ...groupPr, mergeable: "clean" }, reviewDecision: "APPROVED", checks: [], mergeReady: true, blockingReasons: [] }),
      mergePr: vi.fn().mockResolvedValue({ ...groupPr, status: "merged" }),
    };

    await expect(processPullRequestMergeTask(store as never, "/repo", task.id, github as never, () => undefined)).resolves.toBe("merged");
    expect(github.mergePr).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadOid: "1111111111111111111111111111111111111111" }));
    expect(github.mergePr).not.toHaveBeenCalledWith(expect.objectContaining({ auto: true }));
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

  // FNXC:Workspace 2026-07-05-00:00 (FN-7610, defense-in-depth):
  // A workspace-mode shared-group member has no single git repo to resolve a
  // PR against here. Assert the named WorkspaceTaskMergeError fires BEFORE
  // getPrStatus/getCurrentRepo resolution is attempted.
  it("rejects with the named WorkspaceTaskMergeError when a group member is a workspace-mode task, before resolving the repository", async () => {
    const getCurrentRepoMock = vi.mocked(getCurrentRepo);
    getCurrentRepoMock.mockClear();
    const workspaceMembers = [
      { id: "FN-A", title: "Alpha" },
      { id: "FN-B", title: "Beta", workspaceWorktrees: { "repo-a": { worktreePath: "/tmp/a", branch: "fusion/fn-b-a" } } },
    ] as never[];
    const github = { getPrStatus: vi.fn(), updatePr: vi.fn() };
    const sync = syncGroupPrCallback(github as never);
    const rejection = sync({ cwd: "/tmp/project", group: group as never, members: workspaceMembers });
    await expect(rejection).rejects.toMatchObject({ name: "WorkspaceTaskMergeError" });
    expect(getCurrentRepoMock).not.toHaveBeenCalled();
    expect(github.getPrStatus).not.toHaveBeenCalled();
  });

  /*
  FNXC:BranchGroupCompletion 2026-07-04-00:00:
  FN-7532 surface-parity regression: the PR-body checklist must use the SAME
  isBranchGroupMemberLanded predicate as the dashboard route and CLI serializer —
  a landed member ticks [x] and counts toward "Completion: x/N landed", while a
  member merge-confirmed against a sibling/mismatched branch (merge-target-safety)
  must NOT tick or count, even though it is otherwise "merge confirmed".
  */
  it("ticks landed members and counts only genuinely-landed ones toward the completion line", async () => {
    const landedMembers = [
      { id: "FN-A", title: "Alpha", mergeDetails: { mergeConfirmed: true, mergeTargetSource: "branch-group-integration", mergeTargetBranch: group.branchName } },
      { id: "FN-B", title: "Beta", mergeDetails: { mergeConfirmed: true, mergeTargetSource: "branch-group-integration", mergeTargetBranch: "fusion/fn-sibling" } },
      { id: "FN-C", title: "Gamma" },
    ] as never[];
    const github = {
      getPrStatus: vi.fn(async () => ({ number: 42, url: "https://github.com/owner/repo/pull/42", status: "open", title: "T", headBranch: "h", baseBranch: "main", commentCount: 0 })),
      updatePr: vi.fn(async () => ({ number: 42, url: "https://github.com/owner/repo/pull/42", status: "open", title: "T2", headBranch: "h", baseBranch: "main", commentCount: 0 })),
    };
    const sync = syncGroupPrCallback(github as never);
    await sync({ cwd: "/tmp/project", group: group as never, members: landedMembers });
    const body = (github.updatePr.mock.calls[0][0] as { body: string }).body;
    // Only FN-A landed (matching branch); FN-B (sibling-branch mismatch) and
    // FN-C (no merge details) must NOT count, even though FN-B is mergeConfirmed.
    expect(body).toContain("Completion: 1/3 landed");
    expect(body).toContain("- [x] FN-A: Alpha");
    expect(body).toContain("- [ ] FN-B: Beta");
    expect(body).toContain("- [ ] FN-C: Gamma");
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

    expect(github.findPrForBranch).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      head: group.branchName,
      state: "open",
    });
  });

  it("passes the configured integration remote to the group-head refresh", async () => {
    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => ({ number: 98, url: "https://github.com/owner/repo/pull/98", status: "open" as const })),
    };

    await createGroupPrCallback(github as never)({
      cwd: "/repo",
      group: group as never,
      members,
      headBranch: group.branchName,
      baseBranch: "main",
      integrationRemote: "upstream",
    });

    expect(execFileCalls).toContainEqual(expect.objectContaining({
      file: "git",
      args: ["fetch", "upstream", "main"],
    }));
  });

  it("fails closed when promotion is cancelled before its refresh boundary", async () => {
    const controller = new AbortController();
    controller.abort(new Error("promotion cancelled"));
    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(),
    };

    await expect(createGroupPrCallback(github as never)({
      cwd: "/repo",
      group: group as never,
      members,
      headBranch: group.branchName,
      baseBranch: "main",
      signal: controller.signal,
    })).rejects.toThrow("promotion cancelled");
    expect(github.createPr).not.toHaveBeenCalled();
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

    expect(github.findPrForBranch).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      head: group.branchName,
      state: "open",
    });
    expect(github.createPr).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      prNumber: 123,
      prUrl: "https://github.com/owner/repo/pull/123",
      prState: "open",
    });
  });

  it("resolves the repo from the callback cwd and threads owner/repo into findPrForBranch/createPr (gh-4)", async () => {
    vi.mocked(getCurrentRepo).mockImplementation(((cwd?: string) =>
      cwd ? { owner: "central-owner", repo: "central-repo" } : null) as never);
    vi.mocked(getPushRepo).mockReturnValue({ owner: "central-owner", repo: "central-repo" });
    execMock.mockReturnValue("");

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => ({
        number: 5,
        url: "https://github.com/central-owner/central-repo/pull/5",
        status: "open" as const,
      })),
    };

    const callback = createGroupPrCallback(github as never);
    const result = await callback({
      cwd: "/projects/repo-a",
      group: { id: "BG-9", branchName: "fusion/groups/g9" } as never,
      members: [{ id: "FN-9501", title: "m1" }] as never,
      headBranch: "fusion/groups/g9",
      baseBranch: "main",
    });

    expect(vi.mocked(getCurrentRepo)).toHaveBeenCalledWith("/projects/repo-a");
    expect(github.findPrForBranch).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "central-owner", repo: "central-repo", head: "fusion/groups/g9" }),
    );
    expect(github.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "central-owner", repo: "central-repo", head: "fusion/groups/g9" }),
    );
    expect(result.prNumber).toBe(5);
  });

  it("qualifies the group PR head with the fork owner when origin pushes to a fork", async () => {
    vi.mocked(getCurrentRepo).mockImplementation(((cwd?: string) =>
      cwd ? { owner: "central-owner", repo: "central-repo" } : null) as never);
    vi.mocked(getPushRepo).mockReturnValue({ owner: "fork-owner", repo: "central-repo" });
    execMock.mockReturnValue("");

    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => ({
        number: 7,
        url: "https://github.com/central-owner/central-repo/pull/7",
        status: "open" as const,
      })),
    };

    const callback = createGroupPrCallback(github as never);
    await callback({
      cwd: "/projects/repo-a",
      group: { id: "BG-fork", branchName: "fusion/groups/fork" } as never,
      members: [{ id: "FN-9602", title: "m1" }] as never,
      headBranch: "fusion/groups/fork",
      baseBranch: "main",
    });

    expect(vi.mocked(getPushRepo)).toHaveBeenCalledWith("/projects/repo-a");
    expect(github.createPr).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "central-owner",
        repo: "central-repo",
        head: "fork-owner:fusion/groups/fork",
      }),
    );
  });
});

describe("refreshAutomatedPrHead", () => {
  beforeEach(() => {
    execMock.mockReset();
    execFileCalls.length = 0;
    vi.mocked(acquireWorktreePathReservation).mockImplementation(async (input: { canonicalPath: string }) => ({
      canonicalPath: input.canonicalPath,
      state: "held" as const,
      release: vi.fn(async () => undefined),
      quarantine: vi.fn(async () => undefined),
    }) as never);
  });

  it("refuses a cancelled refresh before any git mutation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("execution cancelled"));

    await expect(refreshAutomatedPrHead({
      projectRoot: "/projects/repo-a",
      headBranch: "fusion/fn-cancelled",
      targetBranch: "main",
      signal: controller.signal,
    })).rejects.toThrow("execution cancelled");

    expect(execFileCalls).toEqual([]);
  });

  it("cleans a worktree created during cancellation before returning the failure", async () => {
    refreshFixture.next = 0;
    let addAttempted = false;
    execMock.mockImplementation((command: string) => {
      if (command.startsWith("git worktree add")) {
        addAttempted = true;
        throw new Error("The operation was aborted");
      }
      if (addAttempted && command === "git worktree list --porcelain") {
        return "worktree /projects/repo-a/.worktrees/pr-refresh-49e2094e7f117641\nbranch refs/heads/fusion/fn-cancel-cleanup\n";
      }
      return "";
    });

    await expect(refreshAutomatedPrHead({
      projectRoot: "/projects/repo-a",
      headBranch: "fusion/fn-cancel-cleanup",
      targetBranch: "main",
    })).rejects.toThrow("no verified checkout");

    expect(execFileCalls).toContainEqual(expect.objectContaining({
      file: "git",
      args: ["worktree", "remove", "--force", expect.stringMatching(/\/projects\/repo-a\/\.worktrees\/pr-refresh-/)],
    }));
  });

  it("quarantines a retained temporary checkout when cleanup fails", async () => {
    const reservation = {
      canonicalPath: "/projects/repo-a/.worktrees/pr-refresh-test",
      state: "held" as const,
      release: vi.fn(async () => undefined),
      quarantine: vi.fn(async () => undefined),
    };
    vi.mocked(acquireWorktreePathReservation).mockResolvedValue(reservation as never);
    let worktreeAdded = false;
    execMock.mockImplementation((command: string) => {
      if (command.startsWith("git worktree add")) worktreeAdded = true;
      if (worktreeAdded && command === "git worktree list --porcelain") {
        return "worktree /projects/repo-a/.worktrees/pr-refresh-f7ab243dfb531960\nbranch refs/heads/fusion/fn-cleanup-failure\n";
      }
      if (command.startsWith("git worktree remove --force")) throw new Error("device busy");
      return "";
    });

    await expect(refreshAutomatedPrHead({
      projectRoot: "/projects/repo-a",
      headBranch: "fusion/fn-cleanup-failure",
      targetBranch: "main",
    })).rejects.toThrow("cleanup failed");

    expect(reservation.quarantine).toHaveBeenCalledWith("device busy");
    expect(reservation.release).not.toHaveBeenCalled();
  });

  it("does not roll back a completed push when cancellation arrives after publication", async () => {
    const controller = new AbortController();
    let headReads = 0;
    execMock.mockImplementation((command: string) => {
      if (command === "git rev-parse HEAD") {
        headReads += 1;
        return headReads === 1
          ? "1111111111111111111111111111111111111111\n"
          : "2222222222222222222222222222222222222222\n";
      }
      if (command.startsWith("git push --force-with-lease=")) controller.abort(new Error("cancelled after push"));
      return "";
    });

    await expect(refreshAutomatedPrHead({
      projectRoot: "/projects/repo-a",
      headBranch: "fusion/fn-cancel-after-push",
      targetBranch: "main",
      signal: controller.signal,
    })).resolves.toEqual(expect.objectContaining({
      headOid: "2222222222222222222222222222222222222222",
      refreshed: true,
    }));
    expect(execFileCalls.some((call) => call.args[0] === "update-ref")).toBe(false);
  });

  it("uses the configured integration remote rather than falling back to origin", async () => {
    await refreshAutomatedPrHead({
      projectRoot: "/projects/repo-a",
      headBranch: "fusion/fn-8838",
      targetBranch: "main",
      integrationRemote: "upstream",
    });

    expect(execFileCalls).toContainEqual(expect.objectContaining({
      file: "git",
      args: ["fetch", "upstream", "main"],
    }));
  });

  it("materializes a remote-only head before attaching an isolated worktree", async () => {
    let remoteHeadLookups = 0;
    execMock.mockImplementation((command: string) => {
      if (command === "git rev-parse HEAD") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
      if (command === "git rev-parse --verify refs/heads/fusion/fn-remote") {
        if (remoteHeadLookups++ === 0) {
          const missing = Object.assign(new Error("missing ref"), { code: 128 });
          throw missing;
        }
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
      }
      if (command === "git ls-remote origin refs/heads/fusion/fn-remote") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/fusion/fn-remote\n";
      if (command === "git rev-parse --verify refs/heads/main") return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n";
      return "";
    });

    await refreshAutomatedPrHead({
      projectRoot: "/projects/repo-a",
      headBranch: "fusion/fn-remote",
      targetBranch: "main",
    });

    expect(execFileCalls).toContainEqual(expect.objectContaining({
      file: "git",
      args: ["fetch", "origin", "refs/heads/fusion/fn-remote:refs/heads/fusion/fn-remote"],
      cwd: "/projects/repo-a",
    }));
    expect(execFileCalls).toContainEqual(expect.objectContaining({
      file: "git",
      args: ["worktree", "add", expect.any(String), "fusion/fn-remote"],
    }));
  });
});

describe("createPrNodeGithubOps repo resolution (gh-4)", () => {
  beforeEach(() => {
    execMock.mockReset();
    execFileCalls.length = 0;
    vi.mocked(getCurrentRepo).mockImplementation(((cwd?: string) =>
      cwd ? { owner: "central-owner", repo: "central-repo" } : null) as never);
    vi.mocked(getPushRepo).mockReturnValue({ owner: "central-owner", repo: "central-repo" });
  });

  const githubStub = () => ({
    createPr: vi.fn(async () => ({ number: 9, url: "https://github.com/central-owner/central-repo/pull/9", status: "open" as const })),
    mergePr: vi.fn(async () => ({ number: 9, url: "https://github.com/central-owner/central-repo/pull/9", status: "merged" as const })),
    getPrStatus: vi.fn(),
    replyToReviewThread: vi.fn(),
    resolveReviewThread: vi.fn(),
    getViewerLogin: vi.fn(),
    getPrReviewThreadsDetailed: vi.fn(),
  });

  it("resolvePrSource resolves the repo slug from the task worktree, not process.cwd()", async () => {
    const ops = createPrNodeGithubOps(githubStub() as never);
    const source = await ops.resolvePrSource(
      { id: "FN-9601", worktree: "/projects/repo-a/.worktrees/fn-9601" } as never,
      {} as never,
    );
    expect(source.repo).toBe("central-owner/central-repo");
    expect(vi.mocked(getCurrentRepo)).toHaveBeenCalledWith("/projects/repo-a/.worktrees/fn-9601");
  });

  it("resolvePrSource treats the configured getTaskWorktree resolver as authoritative over task.worktree", async () => {
    const ops = createPrNodeGithubOps(githubStub() as never, {
      getTaskWorktree: (taskId) => `/resolved/${taskId}`,
    });
    const source = await ops.resolvePrSource(
      { id: "FN-9601", worktree: "/stale/recorded/worktree" } as never,
      {} as never,
    );
    expect(source.repo).toBe("central-owner/central-repo");
    expect(vi.mocked(getCurrentRepo)).toHaveBeenCalledWith("/resolved/FN-9601");
  });

  it("resolvePrSource throws instead of persisting entity.repo as '' when no repo resolves (central install, no worktree)", async () => {
    // Worktree-less task in a central install: every cwd candidate (including
    // process.cwd(), the install dir) fails to resolve a repo. Persisting ""
    // would poison downstream splitRepoSlug consumers into the client's
    // process-cwd fallback — the exact gh-4 failure mode.
    vi.mocked(getCurrentRepo).mockReturnValue(null as never);
    const ops = createPrNodeGithubOps(githubStub() as never);
    expect(() => ops.resolvePrSource({ id: "FN-9601" } as never, {} as never)).toThrow(
      /pr-create: could not determine repository for task FN-9601/,
    );
  });

  it("createPr pushes from the task worktree and passes owner/repo parsed from entity.repo", async () => {
    execMock.mockReturnValue("");
    const github = githubStub();
    const ops = createPrNodeGithubOps(github as never);
    const result = await ops.createPr({
      task: { id: "FN-9601", title: "t", description: "d", worktree: "/projects/repo-a/.worktrees/fn-9601" },
      entity: { id: "e1", sourceId: "FN-9601", repo: "central-owner/central-repo", headBranch: "fusion/fn-9601", baseBranch: "main" },
    } as never);
    expect(github.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "central-owner", repo: "central-repo", head: "fusion/fn-9601" }),
    );
    const pushCall = execFileCalls.find((c) => c.file === "git" && c.args[0] === "push");
    expect(pushCall).toBeDefined();
    // The push must run in the task worktree, not process.cwd() (gh-4).
    expect(pushCall?.cwd).toBe("/projects/repo-a/.worktrees/fn-9601");
    expect(result.prNumber).toBe(9);
  });

  it("qualifies the PR head with the fork owner when origin pushes to a fork", async () => {
    execMock.mockReturnValue("");
    vi.mocked(getPushRepo).mockReturnValue({ owner: "fork-owner", repo: "central-repo" });
    const github = githubStub();
    const ops = createPrNodeGithubOps(github as never);

    await ops.createPr({
      task: { id: "FN-9601", title: "t", description: "d", worktree: "/projects/repo-a/.worktrees/fn-9601" },
      entity: { id: "e1", sourceId: "FN-9601", repo: "central-owner/central-repo", headBranch: "fusion/fn-9601", baseBranch: "main" },
    } as never);

    expect(vi.mocked(getPushRepo)).toHaveBeenCalledWith("/projects/repo-a/.worktrees/fn-9601");
    expect(github.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "central-owner", repo: "central-repo", head: "fork-owner:fusion/fn-9601" }),
    );
  });

  it("createPr uses the engine-provided configured integration remote", async () => {
    const github = githubStub();
    const ops = createPrNodeGithubOps(github as never);
    await ops.createPr({
      task: { id: "FN-9601", title: "t", description: "d", worktree: "/projects/repo-a/.worktrees/fn-9601" },
      entity: { id: "e1", sourceId: "FN-9601", repo: "central-owner/central-repo", headBranch: "fusion/fn-9601", baseBranch: "main" },
      integrationRemote: "upstream",
    } as never);

    expect(execFileCalls).toContainEqual(expect.objectContaining({
      file: "git",
      args: ["fetch", "upstream", "main"],
    }));
  });

  it("fails closed when workflow PR creation is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("workflow cancelled"));
    const github = githubStub();

    await expect(createPrNodeGithubOps(github as never).createPr({
      task: { id: "FN-9601", title: "t", description: "d", worktree: "/projects/repo-a/.worktrees/fn-9601" },
      entity: { id: "e1", sourceId: "FN-9601", repo: "central-owner/central-repo", headBranch: "fusion/fn-9601", baseBranch: "main" },
      signal: controller.signal,
    } as never)).rejects.toThrow("workflow cancelled");
    expect(github.createPr).not.toHaveBeenCalled();
  });

  it("mergePr passes owner/repo parsed from entity.repo", async () => {
    const github = githubStub();
    const ops = createPrNodeGithubOps(github as never);
    const result = await ops.mergePr({
      entity: { id: "e1", sourceId: "FN-9601", repo: "central-owner/central-repo", prNumber: 9, headOid: "abc123" },
    } as never);
    expect(result).toEqual({ status: "merged-requested", headOid: "1111111111111111111111111111111111111111" });
    expect(github.mergePr).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "central-owner", repo: "central-repo", number: 9, method: "squash", expectedHeadOid: "1111111111111111111111111111111111111111" }),
    );
    expect(github.mergePr).not.toHaveBeenCalledWith(expect.objectContaining({ auto: true }));
  });

  it("fails closed when workflow PR merge is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("workflow merge cancelled"));
    const github = githubStub();

    await expect(createPrNodeGithubOps(github as never).mergePr({
      entity: { id: "e1", sourceId: "FN-9601", repo: "central-owner/central-repo", prNumber: 9, headOid: "abc123" },
      signal: controller.signal,
    } as never)).rejects.toThrow("workflow merge cancelled");
    expect(github.mergePr).not.toHaveBeenCalled();
  });

  it("resolves native auto-merge against the workflow task rather than a process-global setting", async () => {
    const github = githubStub();
    const resolver = vi.fn(async (task: { id: string }) => task.id === "FN-native");
    const ops = createPrNodeGithubOps(github as never, { isNativeAutoMergeEnabled: resolver });

    await ops.mergePr({
      task: { id: "FN-native" },
      entity: { id: "e1", sourceId: "FN-native", repo: "central-owner/central-repo", prNumber: 9 },
    } as never);
    await ops.mergePr({
      task: { id: "FN-legacy" },
      entity: { id: "e2", sourceId: "FN-legacy", repo: "central-owner/central-repo", prNumber: 10 },
    } as never);

    expect(resolver).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "FN-native" }));
    expect(resolver).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "FN-legacy" }));
    expect(github.mergePr).toHaveBeenNthCalledWith(1, expect.objectContaining({ auto: true }));
    expect(github.mergePr).toHaveBeenNthCalledWith(2, expect.objectContaining({ expectedHeadOid: "1111111111111111111111111111111111111111" }));
  });

  it("propagates unavailable native auto-merge failures from the workflow callback", async () => {
    const github = githubStub();
    github.mergePr.mockRejectedValue(Object.assign(new Error("auto merge disabled"), { code: "auto-merge-unavailable" }));
    const ops = createPrNodeGithubOps(github as never, { isNativeAutoMergeEnabled: () => true });

    await expect(ops.mergePr({
      task: { id: "FN-native" },
      entity: { id: "e1", sourceId: "FN-native", repo: "central-owner/central-repo", prNumber: 9 },
    } as never)).rejects.toMatchObject({ code: "auto-merge-unavailable", message: "auto merge disabled" });
  });

  it("persists the refreshed workflow head before requesting GitHub merge", async () => {
    const calls: string[] = [];
    const github = githubStub();
    github.mergePr.mockImplementation(async () => {
      calls.push("merge");
      return { number: 9, url: "https://github.com/central-owner/central-repo/pull/9", status: "merged" };
    });
    const ops = createPrNodeGithubOps(github as never);
    await ops.mergePr({
      entity: { id: "e1", sourceId: "FN-9601", repo: "central-owner/central-repo", prNumber: 9, headOid: "old" },
      persistRefreshedHead: async () => { calls.push("persist"); },
    } as never);

    expect(calls).toEqual(["persist", "merge"]);
  });
});
