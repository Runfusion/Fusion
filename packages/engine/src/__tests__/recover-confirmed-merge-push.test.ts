import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { recoverConfirmedMergePush } from "../merge/recover-confirmed-merge-push.js";
import { createMergeWriteFence } from "../merge/merge-write-fence.js";

const sha = "a".repeat(40);
let sequence = 0;
function fixture() {
  const task = {
    id: "FN-9368", column: "in-review", updatedAt: "2026-10-04T00:00:00Z",
    mergeDetails: { mergeConfirmed: true, commitSha: sha, mergeTargetBranch: "main" },
    workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "failed", verdict: "REVISE" }],
  } as Task;
  const settings = { autoMerge: true, pushAfterMerge: true } as Settings;
  const store = {
    rootDir: `/repo-${++sequence}`,
    getTask: vi.fn(async () => task), getSettings: vi.fn(async () => settings),
    updateTaskAtomic: vi.fn(async (_id: string, update: (live: Task) => Partial<Task> | null) => {
      const patch = update(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore;
  const run = vi.fn(async (_args: string[], _cwd: string, timeout: number) => {
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(10_000);
    return "";
  });
  return { task, settings, store, run };
}
afterEach(() => vi.useRealTimers());

describe("confirmed landing remote delivery recovery", () => {
  it("recovers a missed push to a bare remote without publishing newer local commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-push-recovery-test-"));
    const execute = promisify(execFile);
    const git = async (args: string[], cwd = root) => (await execute("git", args, { cwd, timeout: 10_000, encoding: "utf8" })).stdout.trim();
    try {
      await git(["init", "--bare", join(root, "remote.git")]);
      await git(["init", "-b", "main", join(root, "local")]);
      const local = join(root, "local");
      const commit = () => git(["-c", "user.name=Test", "-c", "user.email=test@example.org", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "change"], local);
      await commit();
      const landedSha = await git(["rev-parse", "HEAD"], local);
      await commit();
      const newerSha = await git(["rev-parse", "HEAD"], local);
      await git(["remote", "add", "origin", join(root, "remote.git")], local);
      const { task, store, settings } = fixture();
      store.rootDir = local;
      task.mergeDetails!.commitSha = landedSha;
      await recoverConfirmedMergePush(store, task, settings);
      expect(await git(["rev-parse", "refs/heads/main"], join(root, "remote.git"))).toBe(landedSha);
      expect(await git(["rev-parse", "HEAD"], local)).toBe(newerSha);
      expect(task.column).toBe("in-review");
      expect(task.workflowStepResults![0].verdict).toBe("REVISE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pushes only the proven recorded SHA while preserving failed review evidence and lifecycle", async () => {
    const { task, settings, store, run } = fixture();
    const evidence = structuredClone(task.workflowStepResults);
    await recoverConfirmedMergePush(store, task, settings, run);
    expect(run).toHaveBeenCalledWith(["merge-base", "--is-ancestor", sha, "refs/heads/main"], store.rootDir, expect.any(Number));
    expect(run).toHaveBeenCalledWith(["push", "origin", `${sha}:refs/heads/main`], store.rootDir, expect.any(Number));
    expect(task.mergeDetails?.pushRecovery?.pushedAt).toBeTruthy();
    expect(task.column).toBe("in-review");
    expect(task.workflowStepResults).toEqual(evidence);
    run.mockClear();
    await recoverConfirmedMergePush(store, task, settings, run);
    expect(run).not.toHaveBeenCalled();
  });

  it("backs off failed transport durably and succeeds on a later recovery without merging", async () => {
    vi.useFakeTimers();
    const { task, settings, store, run } = fixture();
    run.mockImplementation(async (args) => {
      if (args[0] === "push") throw new Error("transport unavailable");
      return "";
    });
    await recoverConfirmedMergePush(store, task, settings, run);
    expect(task.mergeDetails?.pushRecovery?.error).toContain("transport unavailable");
    run.mockClear();
    // A different process/root identity has no in-memory cooldown but sees the persisted task marker.
    await recoverConfirmedMergePush({ ...store, rootDir: "/restarted" } as TaskStore, task, settings, run);
    expect(run).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    run.mockResolvedValue("");
    await recoverConfirmedMergePush(store, task, settings, run);
    expect(task.mergeDetails?.pushRecovery?.pushedAt).toBeTruthy();
    expect(task.mergeDetails?.pushRecovery?.error).toBeUndefined();
  });

  it.each(["pause", "user-pause", "engine-pause", "global-pause", "push-off", "auto-off", "task-auto-off", "workspace", "shared-group", "pull-request", "lease", "operator-hold"])("honors %s before git or task writes", async (condition) => {
    const { task, settings, store, run } = fixture();
    if (condition === "pause") task.paused = true;
    if (condition === "user-pause") task.userPaused = true;
    if (condition === "engine-pause") settings.enginePaused = true;
    if (condition === "global-pause") settings.globalPause = true;
    if (condition === "push-off") settings.pushAfterMerge = false;
    if (condition === "auto-off") settings.autoMerge = false;
    if (condition === "task-auto-off") task.autoMerge = false;
    if (condition === "shared-group") task.branchContext = { assignmentMode: "shared", groupId: "group" } as Task["branchContext"];
    if (condition === "pull-request") settings.mergeStrategy = "pull-request";
    if (condition === "workspace") task.workspaceWorktrees = {};
    if (condition === "lease") { task.checkoutRunId = "running"; task.checkoutLeaseRenewedAt = new Date().toISOString(); }
    if (condition === "operator-hold") task.status = "awaiting-approval";
    await recoverConfirmedMergePush(store, task, settings, run);
    expect(run).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("treats an older task already reachable from a newer remote tip as delivered", async () => {
    const { task, settings, store, run } = fixture();
    const remoteSha = "b".repeat(40);
    run.mockImplementation(async (args) => {
      if (args[0] === "ls-remote") return `${remoteSha}\trefs/heads/main`;
      if (args[0] === "cat-file") throw new Error("missing object");
      return "";
    });
    await recoverConfirmedMergePush(store, task, settings, run);
    expect(run).toHaveBeenCalledWith(["fetch", "--no-tags", "--no-write-fetch-head", "origin", "refs/heads/main"], store.rootDir, expect.any(Number));
    expect(run.mock.calls.some(([args]) => args[0] === "push")).toBe(false);
    expect(task.mergeDetails?.pushRecovery?.pushedAt).toBeTruthy();
  });

  it("does not push when local reachability cannot prove the landing", async () => {
    const { task, settings, store, run } = fixture();
    run.mockImplementation(async (args) => { if (args[0] === "merge-base") throw new Error("not an ancestor"); return ""; });
    await recoverConfirmedMergePush(store, task, settings, run);
    expect(run.mock.calls.some(([args]) => args[0] === "push")).toBe(false);
    expect(task.mergeDetails?.pushRecovery?.error).toContain("not an ancestor");
  });

  it("deduplicates recovery for different tasks on the same integration target", async () => {
    const { task, settings, store, run } = fixture();
    const other = { ...task, id: "FN-OTHER", mergeDetails: { ...task.mergeDetails!, pushRecovery: undefined } };
    const first = recoverConfirmedMergePush(store, task, settings, run);
    await recoverConfirmedMergePush(store, other, settings, run);
    await first;
    expect(run.mock.calls.filter(([args]) => args[0] === "push")).toHaveLength(1);
  });

  it("releases the branch slot after success so a newer task can push immediately", async () => {
    const first = fixture();
    const second = fixture();
    second.store.rootDir = first.store.rootDir;
    second.task.id = "FN-NEW";
    second.task.mergeDetails!.commitSha = "c".repeat(40);
    await recoverConfirmedMergePush(first.store, first.task, first.settings, first.run);
    await recoverConfirmedMergePush(second.store, second.task, second.settings, second.run);
    expect(second.run.mock.calls.some(([args]) => args[0] === "push")).toBe(true);
  });

  it("honors a pause arriving during the remote probe", async () => {
    const { task, settings, store, run } = fixture();
    run.mockImplementation(async (args) => {
      if (args[0] === "ls-remote") task.userPaused = true;
      return "";
    });
    await recoverConfirmedMergePush(store, task, settings, run);
    expect(run.mock.calls.some(([args]) => args[0] === "push")).toBe(false);
  });

  it("does not overwrite a successor retry marker when a prior push finishes", async () => {
    const { task, settings, store, run } = fixture();
    run.mockImplementation(async (args) => {
      if (args[0] === "push") task.mergeDetails!.pushRecovery = {
        target: "origin/other", commitSha: sha, nextAttemptAt: "2099-01-01T00:00:00Z",
      };
      return "";
    });
    await recoverConfirmedMergePush(store, task, settings, run);
    expect(task.mergeDetails!.pushRecovery).toEqual({ target: "origin/other", commitSha: sha, nextAttemptAt: "2099-01-01T00:00:00Z" });
  });

  it("suppresses all writes and git operations for an aborted merge generation", async () => {
    const { task, settings, store, run } = fixture();
    const controller = new AbortController();
    controller.abort();
    await recoverConfirmedMergePush(store, task, settings, run, createMergeWriteFence({ taskId: task.id, signal: controller.signal }));
    expect(run).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });
});
