import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { acquireTaskWorktree, RepoRootWorktreeError } from "../worktree/worktree-acquisition.js";
import { classifyTaskWorktree, PoolDoubleLeaseError } from "../worktree/worktree-pool.js";
import * as desktopArtifacts from "../worktree/worktree-desktop-artifacts.js";
import * as branchConflicts from "../execution/branch-conflicts.js";

vi.mock("../worktree/worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree-pool.js");
  return {
    ...actual,
    classifyTaskWorktree: vi.fn().mockResolvedValue({ ok: true }),
    isInsideWorktreesDir: vi.fn().mockReturnValue(true),
  };
});

vi.mock("../execution/branch-conflicts.js", async () => {
  const actual = await vi.importActual<any>("../branch-conflicts.js");
  return {
    ...actual,
    classifyBootstrapMisbinding: vi.fn().mockResolvedValue({
      isBootstrapMisbinding: false,
      ownCommitCount: 0,
      foreignCommitCount: 0,
      nonAttributedCount: 0,
    }),
    reanchorBranchToBase: vi.fn().mockResolvedValue({ previousTipSha: "abc", newTipSha: "def" }),
  };
});

vi.mock("../worktree/worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 1, documentsCopied: 1, artifactsCopied: 0 }),
}));

vi.mock("../worktree/worktree-desktop-artifacts.js", () => ({
  removeDesktopBuildArtifacts: vi.fn().mockResolvedValue({ removed: [], skipped: [], failures: [] }),
}));

/*
FNXC:EngineTests 2026-07-21-00:10:
Pool unit tests use temp dirs that are not real git worktrees. installTaskWorktreeIdentityGuard
resolves git paths and throws there, which the pool catch treats as prepare failure and falls
through to fresh. No-op the guard so classification + pool wiring stay under test.
*/
vi.mock("../worktree/worktree-hooks.js", async () => {
  const actual = await vi.importActual<any>("../worktree-hooks.js");
  return {
    ...actual,
    installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
  };
});

const cleanupPaths: string[] = [];
function track(path: string): string {
  cleanupPaths.push(path);
  return path;
}

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeRepo(): string {
  const rootDir = track(mkdtempSync(join(tmpdir(), "fn-6861-acquisition-root-")));
  git(rootDir, "git init -b main");
  git(rootDir, 'git config user.email "test@example.com"');
  git(rootDir, 'git config user.name "Test User"');
  writeFileSync(join(rootDir, "README.md"), "root\n", "utf-8");
  git(rootDir, "git add README.md");
  git(rootDir, 'git commit -m "init"');
  return rootDir;
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("acquireTaskWorktree", () => {
  const task = {
    id: "FN-1",
    title: "Task",
    description: "Desc",
    branch: null,
    worktree: null,
  } as any;

  let store: any;
  beforeEach(() => {
    vi.clearAllMocks();
    /*
    FNXC:EngineTests 2026-07-20-23:55:
    clearAllMocks wipes the hoisted classifyTaskWorktree mockResolvedValue({ ok: true }).
    Re-arm it every test so pool acquisition does not treat undefined as unusable and fall through to fresh.
    */
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true });
    vi.mocked(desktopArtifacts.removeDesktopBuildArtifacts).mockResolvedValue({ removed: [], skipped: [], failures: [] });
    store = {
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("reuses existing usable worktree", async () => {
    const worktreePath = process.cwd();
    const result = await acquireTaskWorktree({
      task: { ...task, worktree: worktreePath, branch: "fusion/fn-1" },
      rootDir: dirname(worktreePath),
      store,
      settings: {},
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fn-worktree-fallback", branch: "fusion/fn-1" }),
    });
    expect(result.source).toBe("existing");
    expect(result.worktreePath).toBe(worktreePath);
  });

  // Regression: FN-5475 — when a resumed worktree's branch was created from
  // a poisoned local-main tip carrying a sibling task's commits and has zero
  // commits of its own, acquireTaskWorktree must re-anchor inline so the
  // executor preflight doesn't pause on contamination forever.
  it("re-anchors a resumed branch when classified as bootstrap-misbinding", async () => {
    const audit = { git: vi.fn().mockResolvedValue(undefined), filesystem: vi.fn() } as any;
    vi.mocked(branchConflicts.classifyBootstrapMisbinding).mockResolvedValueOnce({
      isBootstrapMisbinding: true,
      ownCommitCount: 0,
      foreignCommitCount: 2,
      nonAttributedCount: 0,
    });

    const worktreePath = process.cwd();
    const result = await acquireTaskWorktree({
      task: { ...task, worktree: worktreePath, branch: "fusion/fn-1" },
      rootDir: dirname(worktreePath),
      store,
      settings: {},
      audit,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fn-worktree-fallback", branch: "fusion/fn-1" }),
    });

    expect(result.source).toBe("existing");
    expect(vi.mocked(branchConflicts.reanchorBranchToBase)).toHaveBeenCalledTimes(1);
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({
      type: "branch:reanchor",
      metadata: expect.objectContaining({ trigger: "resume-misbinding" }),
    }));
  });

  it("does not re-anchor a resumed branch when not misbound", async () => {
    const worktreePath = process.cwd();
    const result = await acquireTaskWorktree({
      task: { ...task, worktree: worktreePath, branch: "fusion/fn-1" },
      rootDir: dirname(worktreePath),
      store,
      settings: {},
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fn-worktree-fallback", branch: "fusion/fn-1" }),
    });
    expect(result.source).toBe("existing");
    expect(vi.mocked(branchConflicts.reanchorBranchToBase)).not.toHaveBeenCalled();
  });

  it("derives distinct per-task working branches for shared branch-group members", async () => {
    const createWorktree = vi.fn(async (branchName: string, worktreePath: string) => ({ path: worktreePath, branch: branchName }));
    const sharedBranch = "clionboarding";
    const sharedContext = { assignmentMode: "shared", groupId: "BG-1", source: "planning" } as const;

    const [first, second] = await Promise.all([
      acquireTaskWorktree({
        task: { ...task, id: "FN-100", worktree: null, branch: sharedBranch, branchContext: sharedContext },
        rootDir: process.cwd(),
        store,
        settings: {},
        createWorktree,
      }),
      acquireTaskWorktree({
        task: { ...task, id: "FN-101", worktree: null, branch: sharedBranch, branchContext: sharedContext },
        rootDir: process.cwd(),
        store,
        settings: {},
        createWorktree,
      }),
    ]);

    expect(first.branch).toBe("fusion/fn-100");
    expect(second.branch).toBe("fusion/fn-101");
    expect(first.branch).not.toBe(second.branch);
    expect(createWorktree).toHaveBeenCalledWith("fusion/fn-100", expect.any(String), "FN-100", "main", false);
    expect(createWorktree).toHaveBeenCalledWith("fusion/fn-101", expect.any(String), "FN-101", "main", false);
  });

  it("keeps per-task-derived and ungrouped branch derivation unchanged", async () => {
    const createWorktree = vi.fn(async (branchName: string, worktreePath: string) => ({ path: worktreePath, branch: branchName }));

    const perTaskDerived = await acquireTaskWorktree({
      task: { ...task, id: "FN-102", worktree: null, branch: "fusion/custom-derived", branchContext: { assignmentMode: "per-task-derived", groupId: "BG-1", source: "planning" } },
      rootDir: process.cwd(),
      store,
      settings: {},
      createWorktree,
    });

    const ungrouped = await acquireTaskWorktree({
      task: { ...task, id: "FN-103", worktree: null, branch: null },
      rootDir: process.cwd(),
      store,
      settings: {},
      createWorktree,
    });

    expect(perTaskDerived.branch).toBe("fusion/custom-derived");
    expect(ungrouped.branch).toBe("fusion/fn-103");
  });

  it("creates fresh worktrees from the integration branch instead of ambient root HEAD", async () => {
    const rootDir = makeRepo();
    writeFileSync(join(rootDir, "foreign.txt"), "foreign\n", "utf-8");
    git(rootDir, "git checkout -b fusion/fn-foreign");
    git(rootDir, "git add foreign.txt");
    git(rootDir, 'git commit -m "FN-9999: foreign work"');
    const foreignHead = git(rootDir, "git rev-parse HEAD");
    const mainHead = git(rootDir, "git rev-parse main");
    expect(foreignHead).not.toBe(mainHead);

    const createWorktree = vi.fn(async (branchName: string, worktreePath: string, _taskId: string, startPoint?: string) => {
      git(rootDir, `git worktree add -b ${branchName} ${JSON.stringify(worktreePath)} ${startPoint ?? ""}`);
      return { path: worktreePath, branch: branchName };
    });

    const result = await acquireTaskWorktree({
      task: { ...task, id: "FN-200", worktree: null, branch: null },
      rootDir,
      store,
      settings: {},
      createWorktree,
    });

    expect(createWorktree).toHaveBeenCalledWith("fusion/fn-200", expect.any(String), "FN-200", "main", false);
    expect(git(result.worktreePath, "git rev-parse HEAD")).toBe(mainHead);
  });

  it("acquires from pool when enabled", async () => {
    const prepareForTask = vi.fn().mockResolvedValue({ branch: "fusion/fn-1", worktreePath: "/tmp/pooled", reclaimed: false });
    const release = vi.fn();
    const result = await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true } as any,
      pool: {
        acquire: (_taskId: string) => "/tmp/pooled",
        prepareForTask,
        release,
      } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fn-worktree-fallback", branch: "fusion/fn-1" }),
    });
    expect(release).not.toHaveBeenCalled();
    expect(result.source).toBe("pool");
    expect(prepareForTask).toHaveBeenCalledWith(
      "/tmp/pooled",
      "fusion/fn-1",
      "main",
      expect.objectContaining({ requestingTaskId: "FN-1" }),
    );
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: "/tmp/pooled", branch: "fusion/fn-1" });
    expect(desktopArtifacts.removeDesktopBuildArtifacts).toHaveBeenCalledWith("/tmp/pooled", undefined);
  });

  it("releases acquired pooled worktree when prepareForTask returns reclaimed path", async () => {
    const release = vi.fn();
    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true } as any,
      pool: {
        acquire: (_taskId: string) => "/tmp/pooled",
        prepareForTask: vi.fn().mockResolvedValue({
          branch: "fusion/fn-1",
          worktreePath: "/tmp/live-existing",
          reclaimed: true,
          existingTipSha: "abc123",
          strandedCommitCount: 2,
        }),
        release,
      } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fn-worktree-fallback", branch: "fusion/fn-1" }),
    });

    expect(release).toHaveBeenCalledWith("/tmp/pooled", "FN-1");
  });

  it("falls through to fresh creation when pooled worktree is incomplete and emits detection audit", async () => {
    vi.mocked(classifyTaskWorktree).mockResolvedValueOnce({ ok: false, classification: "incomplete", reason: "missing or invalid .git metadata" });
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" });
    const auditGit = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);

    const result = await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true } as any,
      pool: {
        acquire: (_taskId: string) => "/tmp/pooled",
        prepareForTask: vi.fn().mockResolvedValue({ branch: "fusion/fn-1", worktreePath: "/tmp/pooled", reclaimed: false }),
        release: vi.fn(),
      } as any,
      createWorktree,
      audit: { git: auditGit } as any,
      backend: { kind: "native", create: vi.fn(), remove } as any,
    });

    expect(result.source).toBe("fresh");
    expect(auditGit).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:incomplete-detected",
      metadata: expect.objectContaining({ classification: "incomplete", source: "pool-acquire" }),
    }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", expect.stringContaining("Pool returned incomplete worktree"), undefined, undefined);
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-1", expect.stringMatching(/Refusing to start coding agent/), expect.anything(), expect.anything());
  });

  it("emits resume detection audit and clears session file when assigned worktree is unregistered", async () => {
    vi.mocked(classifyTaskWorktree).mockResolvedValueOnce({ ok: false, classification: "unregistered", reason: "not registered in git worktree list" });
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" });
    const auditGit = vi.fn().mockResolvedValue(undefined);

    await acquireTaskWorktree({
      task: { ...task, worktree: process.cwd(), branch: "fusion/fn-1", sessionFile: "/tmp/session.json" },
      rootDir: process.cwd(),
      store,
      settings: {} as any,
      createWorktree,
      audit: { git: auditGit } as any,
    });

    expect(auditGit).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:incomplete-detected",
      metadata: expect.objectContaining({ classification: "unregistered", source: "resume" }),
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: null, branch: null, sessionFile: null });
  });

  it("FN-6861 creates a fresh configured worktree when a resumed assignment points at the repo root", async () => {
    const rootDir = makeRepo();
    const actualPool = await vi.importActual<typeof import("../worktree/worktree-pool.js")>("../worktree/worktree-pool.js");
    vi.mocked(classifyTaskWorktree).mockImplementationOnce(actualPool.classifyTaskWorktree);
    const freshPath = join(rootDir, ".worktrees", "fn-6861-fresh");
    const createWorktree = vi.fn().mockResolvedValue({ path: freshPath, branch: "fusion/fn-1" });
    const auditGit = vi.fn().mockResolvedValue(undefined);

    const result = await acquireTaskWorktree({
      task: { ...task, worktree: rootDir, branch: "fusion/fn-1", sessionFile: "/tmp/session.json" },
      rootDir,
      store,
      settings: {} as any,
      createWorktree,
      audit: { git: auditGit } as any,
    });

    expect(result).toMatchObject({
      worktreePath: freshPath,
      branch: "fusion/fn-1",
      source: "fresh",
      isResume: false,
    });
    expect(result.worktreePath).not.toBe(rootDir);
    expect(result.worktreePath).toContain(`${join(rootDir, ".worktrees")}/`);
    expect(auditGit).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:incomplete-detected",
      target: rootDir,
      metadata: expect.objectContaining({ classification: "repo-root", source: "resume" }),
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: null, branch: null, sessionFile: null });
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: freshPath, branch: "fusion/fn-1" });
  });

  it("FN-6922 rejects a canonical-equal resumed repo root before returning", async () => {
    const rootDir = makeRepo();
    const actualPool = await vi.importActual<typeof import("../worktree/worktree-pool.js")>("../worktree/worktree-pool.js");
    vi.mocked(classifyTaskWorktree).mockImplementationOnce(actualPool.classifyTaskWorktree);
    const freshPath = join(rootDir, ".worktrees", "fn-6922-trailing-slash");
    const createWorktree = vi.fn().mockResolvedValue({ path: freshPath, branch: "fusion/fn-1" });

    const result = await acquireTaskWorktree({
      task: { ...task, worktree: `${rootDir}/`, branch: "fusion/fn-1", sessionFile: "/tmp/session.json" },
      rootDir,
      store,
      settings: {} as any,
      createWorktree,
    });

    expect(result.worktreePath).toBe(freshPath);
    expect(result.worktreePath).not.toBe(rootDir);
    expect(result.isResume).toBe(false);
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: null, branch: null, sessionFile: null });
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: freshPath, branch: "fusion/fn-1" });
  });

  it("FN-6922 self-heals when the return guard catches a mocked repo-root resume", async () => {
    const rootDir = makeRepo();
    vi.mocked(classifyTaskWorktree).mockResolvedValueOnce({ ok: true });
    const freshPath = join(rootDir, ".worktrees", "fn-6922-guard-fresh");
    const createWorktree = vi.fn().mockResolvedValue({ path: freshPath, branch: "fusion/fn-1" });
    const auditGit = vi.fn().mockResolvedValue(undefined);

    const result = await acquireTaskWorktree({
      task: { ...task, worktree: rootDir, branch: "fusion/fn-1", sessionFile: "/tmp/session.json" },
      rootDir,
      store,
      settings: {} as any,
      createWorktree,
      audit: { git: auditGit } as any,
    });

    expect(result).toMatchObject({ worktreePath: freshPath, source: "fresh", isResume: false });
    expect(createWorktree).toHaveBeenCalledWith("fusion/fn-1", expect.stringContaining(`${join(rootDir, ".worktrees")}/`), "FN-1", "main", false);
    expect(auditGit).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:incomplete-detected",
      target: rootDir,
      metadata: expect.objectContaining({ classification: "repo-root", source: "acquire-return-guard", returnSource: "existing" }),
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: null, branch: null, sessionFile: null });
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: freshPath, branch: "fusion/fn-1" });
  });

  it("FN-6922 throws a typed error when fresh creation returns the repo root", async () => {
    const rootDir = makeRepo();
    const auditGit = vi.fn().mockResolvedValue(undefined);

    await expect(acquireTaskWorktree({
      task: { ...task, worktree: null, branch: null },
      rootDir,
      store,
      settings: {} as any,
      createWorktree: vi.fn().mockResolvedValue({ path: rootDir, branch: "fusion/fn-1" }),
      audit: { git: auditGit } as any,
    })).rejects.toBeInstanceOf(RepoRootWorktreeError);

    expect(auditGit).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:incomplete-detected",
      target: rootDir,
      metadata: expect.objectContaining({ classification: "repo-root", source: "acquire-return-guard", returnSource: "fresh" }),
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: null, branch: null, sessionFile: null });
  });

  it("falls through to fresh creation when pool acquire throws PoolDoubleLeaseError", async () => {
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" });
    const result = await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true } as any,
      pool: {
        acquire: () => {
          throw new PoolDoubleLeaseError("/tmp/pooled", "FN-OTHER", "FN-1", "acquire");
        },
        prepareForTask: vi.fn(),
        release: vi.fn(),
      } as any,
      createWorktree,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.source).toBe("fresh");
    expect(createWorktree).toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", expect.stringContaining("Pool double-lease guard triggered"), undefined, undefined);
  });

  it("creates fresh when pool disabled", async () => {
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" });
    const result = await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: {},
      createWorktree,
    });
    expect(result.source).toBe("fresh");
    expect(createWorktree).toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: "/tmp/new", branch: "fusion/fn-1" });
  });

  it("skips init command when runInitCommand false", async () => {
    const runConfiguredCommand = vi.fn();
    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { worktreeInitCommand: "pnpm i" } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" }),
      runConfiguredCommand,
      runInitCommand: false,
    });
    expect(runConfiguredCommand).not.toHaveBeenCalled();
  });

  it("invokes desktop artifact cleanup before init command for fresh acquisition", async () => {
    const runConfiguredCommand = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });

    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { worktreeInitCommand: "pnpm install" } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" }),
      runConfiguredCommand,
      runInitCommand: true,
    });

    expect(desktopArtifacts.removeDesktopBuildArtifacts).toHaveBeenCalledWith("/tmp/new", undefined);
    const cleanupOrder = vi.mocked(desktopArtifacts.removeDesktopBuildArtifacts).mock.invocationCallOrder[0];
    const initOrder = runConfiguredCommand.mock.invocationCallOrder[0];
    expect(cleanupOrder).toBeLessThan(initOrder);
  });

  it("copies configured files for fresh acquisition before init command", async () => {
    const rootDir = track(mkdtempSync(join(tmpdir(), "fn-copy-fresh-root-")));
    const worktreePath = track(mkdtempSync(join(tmpdir(), "fn-copy-fresh-worktree-")));
    writeFileSync(join(rootDir, ".env"), "SECRET=redacted\n", "utf-8");
    const runConfiguredCommand = vi.fn().mockImplementation(async () => {
      expect(readFileSync(join(worktreePath, ".env"), "utf-8")).toBe("SECRET=redacted\n");
      return { exitCode: 0, stderr: "", stdout: "" };
    });

    await acquireTaskWorktree({
      task,
      rootDir,
      store,
      settings: { worktreeCopyFiles: [".env"], worktreeInitCommand: "pnpm install" } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: worktreePath, branch: "fusion/fn-1" }),
      runConfiguredCommand,
      runInitCommand: true,
    });

    expect(readFileSync(join(worktreePath, ".env"), "utf-8")).toBe("SECRET=redacted\n");
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Copied configured worktree files into fresh worktree: .env", undefined, undefined);
  });

  it("invokes desktop artifact cleanup once for pooled acquisition", async () => {
    const runConfiguredCommand = vi.fn();
    const pooledPath = track(mkdtempSync(join(tmpdir(), "fn-pooled-cleanup-")));

    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true, worktreeInitCommand: "pnpm install" } as any,
      pool: {
        acquire: (_taskId: string) => pooledPath,
        prepareForTask: vi.fn().mockResolvedValue({ branch: "fusion/fn-1", worktreePath: pooledPath, reclaimed: false }),
        release: vi.fn(),
      } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fn-worktree-fallback", branch: "fusion/fn-1" }),
      runConfiguredCommand,
      runInitCommand: true,
    });

    expect(desktopArtifacts.removeDesktopBuildArtifacts).toHaveBeenCalledTimes(1);
    expect(desktopArtifacts.removeDesktopBuildArtifacts).toHaveBeenCalledWith(pooledPath, undefined);
    expect(runConfiguredCommand).not.toHaveBeenCalled();
  });

  it("copies configured files into pooled worktrees after preparation", async () => {
    const rootDir = track(mkdtempSync(join(tmpdir(), "fn-copy-pool-root-")));
    const worktreePath = track(mkdtempSync(join(tmpdir(), "fn-copy-pool-worktree-")));
    writeFileSync(join(rootDir, ".env"), "POOL=updated\n", "utf-8");
    writeFileSync(join(worktreePath, ".env"), "POOL=old\n", "utf-8");

    const result = await acquireTaskWorktree({
      task,
      rootDir,
      store,
      settings: { recycleWorktrees: true, worktreeCopyFiles: [".env"] } as any,
      pool: {
        acquire: (_taskId: string) => worktreePath,
        prepareForTask: vi.fn().mockResolvedValue({ branch: "fusion/fn-1", worktreePath, reclaimed: false }),
        release: vi.fn(),
      } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fn-worktree-fallback", branch: "fusion/fn-1" }),
    });

    expect(result.source).toBe("pool");
    expect(readFileSync(join(worktreePath, ".env"), "utf-8")).toBe("POOL=updated\n");
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Copied configured worktree files into pool worktree: .env", undefined, undefined);
  });

  it("does not copy configured files over resumed worktree state", async () => {
    const rootDir = track(mkdtempSync(join(tmpdir(), "fn-copy-resume-root-")));
    const worktreePath = track(mkdtempSync(join(tmpdir(), "fn-copy-resume-worktree-")));
    writeFileSync(join(rootDir, ".env"), "ROOT=updated\n", "utf-8");
    writeFileSync(join(worktreePath, ".env"), "RESUME=keep\n", "utf-8");

    const result = await acquireTaskWorktree({
      task: { ...task, worktree: worktreePath, branch: "fusion/fn-1" },
      rootDir,
      store,
      settings: { worktreeCopyFiles: [".env"] } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fn-worktree-fallback", branch: "fusion/fn-1" }),
    });

    expect(result.source).toBe("existing");
    expect(readFileSync(join(worktreePath, ".env"), "utf-8")).toBe("RESUME=keep\n");
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-1", expect.stringContaining("Copied configured worktree files"), undefined, undefined);
    expect(existsSync(join(worktreePath, ".env"))).toBe(true);
  });

  it("FN-4834: logs worktree init stderr in task log outcome", async () => {
    const runConfiguredCommand = vi.fn().mockResolvedValue({
      exitCode: 1,
      stderr: "ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date",
      stdout: "",
    });

    await expect(acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { worktreeInitCommand: "pnpm install --frozen-lockfile" } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" }),
      runConfiguredCommand,
      runInitCommand: true,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })).resolves.toBeTruthy();

    const failureCall = store.logEntry.mock.calls.find((call: unknown[]) => String(call[1]).startsWith("Worktree init command failed"));
    expect(failureCall).toBeDefined();
    expect(failureCall?.[2]).toContain("ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE");
  });
});

describe("acquireTaskWorktree foreign start-point warning", () => {
  it("emits warning/log for fusion/fn-* start point with foreign-attributed tip and stays silent for main", async () => {
    vi.resetModules();
    const warn = vi.fn();
    const logEntry = vi.fn().mockResolvedValue(undefined);

    const execMock: any = (_command: string, _opts: any, cb: any) => cb(null, "", "");
    execMock[promisify.custom] = (command: string) => {
      if (command.startsWith("git rev-parse --verify \"fusion/fn-4367^")) {
        return Promise.resolve({ stdout: "deadbeefdeadbeef\n", stderr: "" });
      }
      if (command.startsWith("git log -1 --format=%s%x1f%b")) {
        return Promise.resolve({ stdout: "feat(FN-4367): dep\u001fFusion-Task-Id: FN-4367\n", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    vi.doMock("node:child_process", () => ({ exec: execMock, execFile: execMock }));
    const mod = await import("../worktree/worktree-acquisition.js");

    await mod.acquireTaskWorktree({
      task: { id: "FN-4488", title: "Task", description: "Desc", branch: null, worktree: null, executionStartBranch: "fusion/fn-4367" } as any,
      rootDir: "/tmp/repo",
      store: { updateTask: vi.fn().mockResolvedValue(undefined), logEntry } as any,
      settings: {},
      logger: { log: vi.fn(), warn, error: vi.fn() },
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/repo/.worktrees/x", branch: "fusion/fn-4488" }),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("worktree acquired with foreign-task start point: fusion/fn-4367"));
    expect(logEntry).toHaveBeenCalledWith("FN-4488", expect.stringContaining("worktree acquired with foreign-task start point: fusion/fn-4367"), undefined, undefined);

    warn.mockClear();
    logEntry.mockClear();

    await mod.acquireTaskWorktree({
      task: { id: "FN-4488", title: "Task", description: "Desc", branch: null, worktree: null, executionStartBranch: "main" } as any,
      rootDir: "/tmp/repo",
      store: { updateTask: vi.fn().mockResolvedValue(undefined), logEntry } as any,
      settings: {},
      logger: { log: vi.fn(), warn, error: vi.fn() },
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/repo/.worktrees/x", branch: "fusion/fn-4488" }),
    });

    expect(warn).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalledWith("FN-4488", expect.stringContaining("foreign-task start point"), undefined, undefined);
  });
});
