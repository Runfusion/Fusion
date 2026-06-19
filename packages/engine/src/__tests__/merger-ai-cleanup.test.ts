import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { cleanupAiMergeWorktree, pruneExistingAiMergeWorktrees, resolveAiMergeRoot, runAiMerge } from "../merger-ai.js";
import { activeSessionRegistry } from "../active-session-registry.js";
import { MIN_TEMP_WORKTREE_REAP_AGE_MS } from "../self-healing.js";
import { classifyTransientMergeError } from "../transient-merge-error-classifier.js";
import { resolveAiMergeRootPath, resolveLegacyAiMergeRootPath, resolveWorktreesDir } from "../worktree-paths.js";
import type { RunAuditor } from "../run-audit.js";

const fsState = vi.hoisted(() => ({ failReaddirPath: "" }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readdirSync: vi.fn((path: Parameters<typeof actual.readdirSync>[0], options?: Parameters<typeof actual.readdirSync>[1]) => {
      if (String(path) === fsState.failReaddirPath) throw new Error("simulated readdir failure");
      return actual.readdirSync(path, options as never);
    }),
  };
});

const tracked = new Set<string>();
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;

afterEach(() => {
  vi.restoreAllMocks();
  fsState.failReaddirPath = "";
  /*
  FNXC:EngineTests 2026-06-14-02:10:
  This file observes AI-merge active-session state while sibling files may also be asserting live registrations. Do not clear the shared registry here; production cleanup paths must unregister their own entries, and broad singleton clears make package-load rescue nondeterministic.
  */
  for (const dir of tracked) {
    try { rmSync(dir, RM); } catch { /* best effort */ }
  }
  tracked.clear();
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8" }).trim();
}

function makeAudit() {
  const events: any[] = [];
  const audit: RunAuditor = {
    git: vi.fn(async (event: any) => { events.push(event); }),
    database: vi.fn(async () => undefined),
    filesystem: vi.fn(async () => undefined),
    sandbox: vi.fn(async () => undefined),
  };
  return { audit, events };
}

async function cleanup(input: Partial<Parameters<typeof cleanupAiMergeWorktree>[0]> = {}) {
  const mergeRoot = input.mergeRoot ?? mkdtempSync(join(tmpdir(), "fusion-ai-merge-fn-1-cleanup-test-"));
  tracked.add(mergeRoot);
  const { audit, events } = makeAudit();
  const logs: string[] = [];
  await cleanupAiMergeWorktree({
    taskId: "FN-1",
    mergeRoot,
    projectRootDir: input.projectRootDir ?? process.cwd(),
    worktreeAdded: input.worktreeAdded ?? true,
    audit: input.audit ?? audit,
    log: input.log ?? vi.fn(async (message: string) => { logs.push(message); }),
    gitRunner: input.gitRunner ?? vi.fn(async () => ""),
    rmRunner: input.rmRunner ?? rm,
  });
  return { mergeRoot, events, logs };
}

function initRepoWithBranch(taskId = "FN-1"): { dir: string } {
  const branch = `fusion/${taskId.toLowerCase()}`;
  const dir = mkdtempSync(join(tmpdir(), "fusion-ai-merge-cleanup-test-"));
  tracked.add(dir);
  git(dir, "init -q -b main");
  git(dir, "config user.email t@t.t");
  git(dir, "config user.name t");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, "add -A");
  git(dir, "commit -q -m base");
  git(dir, `checkout -q -b ${branch}`);
  writeFileSync(join(dir, "feature.txt"), "feature work\n");
  git(dir, "add -A");
  git(dir, "commit -q -m 'feat: work'");
  git(dir, "checkout -q main");
  return { dir };
}

function makeStore(taskId = "FN-1") {
  const task: any = {
    id: taskId,
    column: "in-review",
    status: null,
    branch: `fusion/${taskId.toLowerCase()}`,
    worktree: null,
    title: "do the thing",
    steps: [],
  };
  const audits: any[] = [];
  const logs: string[] = [];
  const store: any = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ merger: { mode: "ai", maxReviewPasses: 1 } })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return task; }),
    moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; return task; }),
    emit: vi.fn(),
    logEntry: vi.fn(async (_id: string, message: string) => { logs.push(message); }),
    appendAgentLog: vi.fn(async (_id: string, message: string) => { logs.push(message); }),
    recordRunAuditEvent: vi.fn(async (event: any) => { audits.push(event); }),
  };
  return { store, audits, logs };
}

function tempAiMergeDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  tracked.add(dir);
  return dir;
}

function localAiMergeDir(projectRoot: string, name: string): string {
  const dir = join(resolveAiMergeRoot(projectRoot), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function legacyRepoAiMergeDir(projectRoot: string, name: string): string {
  const dir = join(resolveLegacyAiMergeRootPath(projectRoot), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tempProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-ai-merge-project-"));
  tracked.add(dir);
  return dir;
}

function makeAge(path: string, ageMs: number): void {
  const old = new Date(Date.now() - ageMs);
  utimesSync(path, old, old);
}

function realMergeAgent(taskId = "FN-1") {
  return vi.fn(async (cwd: string) => {
    execSync(`git merge --squash fusion/${taskId.toLowerCase()}`, { cwd, stdio: "pipe" });
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync('git commit -q -m "squash: feature"', { cwd, stdio: "pipe" });
  });
}

describe("AI merge temp worktree cleanup", () => {
  it("emits audit event and logs stderr on git worktree removal failure", async () => {
    const err = new Error("git remove failed") as Error & { stderr?: string; code?: string };
    err.stderr = "fatal: simulated worktree remove failure";
    err.code = "1";

    const { mergeRoot, events, logs } = await cleanup({ gitRunner: vi.fn(async () => { throw err; }) });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "git-remove", success: false, error: expect.stringContaining("simulated worktree remove failure"), code: "1" }) }),
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: true }) }),
    ]));
    expect(logs.join("\n")).toContain("simulated worktree remove failure");
    expect(existsSync(mergeRoot)).toBe(false);
  });

  it("emits audit event and logs errno details on filesystem rm failure", async () => {
    const err = new Error("simulated filesystem cleanup denial") as NodeJS.ErrnoException;
    err.code = "EACCES";

    const { events, logs } = await cleanup({ rmRunner: vi.fn(async () => { throw err; }) as typeof rm });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "git-remove", success: true }) }),
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: false, code: "EACCES", error: expect.stringContaining("simulated filesystem cleanup denial") }) }),
    ]));
    expect(logs.join("\n")).toContain("EACCES");
  });

  it("emits success audit events on happy-path cleanup", async () => {
    const { events } = await cleanup();

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "git-remove", success: true }) }),
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: true }) }),
    ]));
  });

  it("treats spawn git ENOENT during cleanup as idempotent already-absent success", async () => {
    const mergeRoot = mkdtempSync(join(tmpdir(), "fusion-ai-merge-fn-1-enoent-cleanup-test-"));
    tracked.add(mergeRoot);
    const canonicalMergeRoot = realpathSync(mergeRoot);
    const err = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    const gitRunner = vi.fn(async () => { throw err; });

    const { events, logs } = await cleanup({
      mergeRoot,
      gitRunner,
    });

    expect(gitRunner).toHaveBeenCalledWith(["worktree", "remove", "--force", canonicalMergeRoot], process.cwd());

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "git-remove", success: true, alreadyAbsent: true, idempotent: true, code: "ENOENT" }) }),
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: true, alreadyAbsent: true, idempotent: true }) }),
    ]));
    expect(logs.join("\n")).toContain("treating cleanup as idempotent");
  });

  it("removes the directory after git reports the temp path is not a working tree", async () => {
    const err = new Error("Command failed: git worktree remove --force /tmp/fusion-ai-merge-fn-1\nfatal: '/tmp/fusion-ai-merge-fn-1' is not a working tree");

    const { mergeRoot, events } = await cleanup({
      gitRunner: vi.fn(async () => { throw err; }),
    });

    expect(existsSync(mergeRoot)).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "git-remove", success: true, alreadyAbsent: true, idempotent: true }) }),
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: true, alreadyAbsent: true, idempotent: true }) }),
    ]));
  });

  it("still surfaces genuine filesystem cleanup failures", async () => {
    const err = new Error("Directory not empty") as NodeJS.ErrnoException;
    err.code = "ENOTEMPTY";

    const { events, logs } = await cleanup({ rmRunner: vi.fn(async () => { throw err; }) as typeof rm });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: false, code: "ENOTEMPTY", error: "Directory not empty" }) }),
    ]));
    expect(logs.join("\n")).toContain("filesystem rm failed");
  });

  it("skips git removal but still audits filesystem cleanup when worktree was not added", async () => {
    const gitRunner = vi.fn(async () => "");

    const { events } = await cleanup({ worktreeAdded: false, gitRunner });

    expect(gitRunner).toHaveBeenCalledTimes(1);
    expect(gitRunner).toHaveBeenCalledWith(["worktree", "prune"], expect.any(String), { timeout: 30_000 });
    expect(events.some((event) => event.metadata.phase === "git-remove")).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: true }) }),
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "git-prune", success: true }) }),
    ]));
  });

  it("prunes stale worktree metadata after git removal failure", async () => {
    const err = new Error("git remove failed") as Error & { stderr?: string; code?: string };
    err.stderr = "fatal: not a working tree registered in git metadata";
    err.code = "1";
    const gitRunner = vi.fn(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "remove" && args[2] === "--force") throw err;
      return "";
    });

    const { mergeRoot, events, logs } = await cleanup({ gitRunner });

    expect(existsSync(mergeRoot)).toBe(false);
    expect(gitRunner).toHaveBeenCalledWith(["worktree", "prune"], expect.any(String), { timeout: 30_000 });
    expect(logs.join("\n")).toContain("not a working tree registered");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "git-remove", success: false }) }),
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: true }) }),
      expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "git-prune", success: true }) }),
    ]));
  });

  it("pruneExistingAiMergeWorktrees removes stale same-task directories from new and legacy roots", async () => {
    const projectRoot = tempProjectRoot();
    const staleNew = localAiMergeDir(projectRoot, "fusion-ai-merge-fn-777-stale-new");
    const staleLegacyRepo = legacyRepoAiMergeDir(projectRoot, "fusion-ai-merge-fn-777-stale-legacy-repo");
    const staleLegacyTmp = tempAiMergeDir("fusion-ai-merge-fn-777-stale-tmp");
    for (const stale of [staleNew, staleLegacyRepo, staleLegacyTmp]) {
      makeAge(stale, MIN_TEMP_WORKTREE_REAP_AGE_MS + 1_000);
    }
    const canonicalStale = [staleNew, staleLegacyRepo, staleLegacyTmp].map((path) => realpathSync(path));
    const { audit, events } = makeAudit();
    const logs: string[] = [];

    await expect(pruneExistingAiMergeWorktrees("FN-777", projectRoot, audit, vi.fn(async (message: string) => { logs.push(message); }))).resolves.toBe(3);

    expect(existsSync(staleNew)).toBe(false);
    expect(existsSync(staleLegacyRepo)).toBe(false);
    expect(existsSync(staleLegacyTmp)).toBe(false);
    for (const mergeRoot of canonicalStale) {
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ taskId: "FN-777", mergeRoot, phase: "pre-merge-prune", success: true }) }),
      ]));
    }
  });

  it("pruneExistingAiMergeWorktrees skips too-new same-task directories", async () => {
    const fresh = tempAiMergeDir("fusion-ai-merge-fn-777-fresh");
    const { audit, events } = makeAudit();
    const logs: string[] = [];

    const projectRoot = tempProjectRoot();

    await expect(pruneExistingAiMergeWorktrees("FN-777", projectRoot, audit, vi.fn(async (message: string) => { logs.push(message); }))).resolves.toBe(0);

    expect(existsSync(fresh)).toBe(true);
    expect(events).toEqual([]);
    expect(logs.join("\n")).toContain("skipping too-new worktree");
  });

  it("pruneExistingAiMergeWorktrees skips directories for other tasks", async () => {
    const other = tempAiMergeDir("fusion-ai-merge-fn-778-stale");
    const { audit, events } = makeAudit();

    const projectRoot = tempProjectRoot();

    await expect(pruneExistingAiMergeWorktrees("FN-777", projectRoot, audit, vi.fn(async () => undefined))).resolves.toBe(0);

    expect(existsSync(other)).toBe(true);
    expect(events).toEqual([]);
  });

  it("runAiMerge registers the clean-room worktree while merging and unregisters after", async () => {
    const { dir } = initRepoWithBranch();
    const { store, audits } = makeStore();
    let observedMergeRoot = "";
    const mergeAgent = vi.fn(async (cwd: string) => {
      observedMergeRoot = cwd;
      expect(activeSessionRegistry.isPathActive(realpathSync(cwd))).toBe(true);
      expect(activeSessionRegistry.isPathActive(cwd)).toBe(true);
      await realMergeAgent()(cwd);
    });

    await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent,
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    const expectedRoot = join(resolveWorktreesDir(dir, undefined), ".ai-merge");
    expect(observedMergeRoot).toContain("fusion-ai-merge-fn-1-");
    expect(observedMergeRoot.startsWith(expectedRoot)).toBe(true);
    expect(observedMergeRoot.startsWith(resolveAiMergeRootPath(dir, undefined))).toBe(true);
    expect(observedMergeRoot.startsWith(join(tmpdir(), "fusion-ai-merge-fn-1-"))).toBe(false);
    expect(observedMergeRoot.startsWith(resolveLegacyAiMergeRootPath(dir))).toBe(false);
    expect(observedMergeRoot.startsWith(resolveAiMergeRoot(dir))).toBe(true);
    expect(activeSessionRegistry.pathsForTask("FN-1")).toEqual([]);
    const cleanupEvents = audits.filter((event) => event.mutationType === "merge:ai-worktree-cleanup");
    expect(cleanupEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ metadata: expect.objectContaining({ phase: "git-remove", success: true }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ phase: "fs-rm", success: true }) }),
    ]));
  });

  it("runAiMerge calls pre-merge prune before creating worktree", async () => {
    const taskId = "FN-777";
    const { dir } = initRepoWithBranch(taskId);
    const orphan = tempAiMergeDir("fusion-ai-merge-fn-777-orphan");
    makeAge(orphan, MIN_TEMP_WORKTREE_REAP_AGE_MS + 1_000);
    const { store, audits } = makeStore(taskId);

    await runAiMerge(store, dir, taskId, { manual: true }, {
      mergeAgent: realMergeAgent(taskId),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(existsSync(orphan)).toBe(false);
    expect(audits.filter((event) => event.mutationType === "merge:ai-worktree-cleanup")).toEqual(expect.arrayContaining([
      expect.objectContaining({ metadata: expect.objectContaining({ phase: "pre-merge-prune", success: true }) }),
    ]));
  });

  it("classifies a clean-room deleted mid-merge as transient", async () => {
    const { dir } = initRepoWithBranch();
    const { store } = makeStore();
    let observedMergeRoot = "";

    let thrown: unknown;
    try {
      await runAiMerge(store, dir, "FN-1", { manual: true }, {
        mergeAgent: vi.fn(async (cwd: string) => {
          observedMergeRoot = cwd;
          rmSync(cwd, { recursive: true, force: true });
          throw Object.assign(new Error("spawn git ENOTDIR"), { code: "ENOTDIR" });
        }),
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      });
    } catch (err: unknown) {
      thrown = err;
    }

    expect(observedMergeRoot.startsWith(resolveAiMergeRootPath(dir, undefined))).toBe(true);
    expect(observedMergeRoot.startsWith(resolveLegacyAiMergeRootPath(dir))).toBe(false);
    expect(String(thrown)).toMatch(/ENOENT|ENOTDIR|not a working tree/i);
    expect(classifyTransientMergeError(String(thrown))).toBe("process-spawn-failure");
  });

  it("pre-merge prune failure does not abort merge", async () => {
    const { dir } = initRepoWithBranch();
    const { store, logs } = makeStore();
    fsState.failReaddirPath = tmpdir();

    await expect(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent(),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    })).resolves.toMatchObject({ ok: true, merged: true });
    expect(logs.join("\n")).toContain("pre-merge prune failed");
  });
});
