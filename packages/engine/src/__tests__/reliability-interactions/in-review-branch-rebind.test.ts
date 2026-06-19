import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logger } = vi.hoisted(() => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../logger.js", () => ({ createLogger: vi.fn(() => logger) }));

import { TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
}

describe("FN-5083 reliability interactions: in-review branch rebind", () => {
  let rootDir = "";
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fn-5083-reliability-"));
    git(rootDir, "init -b main");
    git(rootDir, "config user.name 'Fusion'");
    git(rootDir, "config user.email 'hi@runfusion.ai'");
    writeFileSync(join(rootDir, "README.md"), "root\n");
    git(rootDir, "add README.md");
    git(rootDir, "commit -m 'init'");
    store = new TaskStore(rootDir, undefined, { inMemoryDb: false });
  });

  afterEach(() => {
    try { store?.close(); } catch {}
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function createTaskInReview(title: string) {
    const task = await store.createTask({ title, description: title });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    return task.id;
  }

  async function createUniqueFusionBranch(taskId: string, suffix: string) {
    const branch = `fusion/${taskId.toLowerCase()}`;
    git(rootDir, `checkout -b ${branch}`);
    writeFileSync(join(rootDir, `${taskId}-${suffix}.txt`), `${suffix}\n`);
    git(rootDir, `add ${taskId}-${suffix}.txt`);
    git(rootDir, `commit -m '${suffix} commit'`);
    git(rootDir, "checkout main");
    return branch;
  }

  function spyOnRebindAudit(manager: SelfHealingManager) {
    return vi.spyOn(manager as any, "emitBranchRebindAuditEvent");
  }

  it("rebinds and remains stable on repeated sweeps", async () => {
    const id = await createTaskInReview("stable rebind");
    const branch = await createUniqueFusionBranch(id, "stable");
    await store.updateTask(id, { branch: null, worktree: null });

    const manager = new SelfHealingManager(store, { rootDir });
    const audit = spyOnRebindAudit(manager);
    const first = await manager.reconcileInReviewBranchRebind({ includeTaskIds: new Set([id]) });
    const second = await manager.reconcileInReviewBranchRebind({ includeTaskIds: new Set([id]) });
    const updated = await store.getTask(id);

    expect(first.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: id, result: "applied", branch })]));
    expect(updated?.branch).toBe(branch);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      taskId: id,
      mutationType: "task:auto-rebind-applied",
      metadata: expect.objectContaining({ branch, source: "auto-rebind-in-review" }),
    }));
    expect(second.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: id, result: "skipped", reason: "binding-intact" }),
    ]));
  });

  it("skips auto-rebind when user-paused task intent blocks engine mutation", async () => {
    const id = await createTaskInReview("user paused safety gate");
    const branch = await createUniqueFusionBranch(id, "paused");
    const brokenBranch = `fusion/missing-${id.toLowerCase()}`;
    await store.updateTask(id, { branch: brokenBranch, worktree: null });
    const originalListTasks = store.listTasks.bind(store);
    vi.spyOn(store, "listTasks").mockImplementationOnce(async (opts: any) => {
      const tasks = await originalListTasks(opts);
      return tasks.map((task: any) => task.id === id ? { ...task, userPaused: true } : task);
    });

    const manager = new SelfHealingManager(store, { rootDir });
    const audit = spyOnRebindAudit(manager);
    const result = await manager.reconcileInReviewBranchRebind({ includeTaskIds: new Set([id]) });
    const updated = await store.getTask(id);

    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: id, result: "skipped", reason: "unsafe-to-auto-mutate:user-paused" }),
    ]));
    expect(updated?.branch).toBe(brokenBranch);
    expect(updated?.branch).not.toBe(branch);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      taskId: id,
      mutationType: "task:auto-rebind-skipped",
      metadata: expect.objectContaining({
        reason: "unsafe-to-auto-mutate:user-paused",
        branch,
      }),
    }));
  });

  it("skips auto-rebind when a checked-out task has a live metadata lease", async () => {
    const id = await createTaskInReview("checked out safety gate");
    const branch = await createUniqueFusionBranch(id, "checked-out");
    const brokenBranch = `fusion/missing-${id.toLowerCase()}`;
    await store.updateTask(id, { branch: brokenBranch, worktree: null, checkedOutBy: "agent-123" });

    const manager = new SelfHealingManager(store, { rootDir });
    const audit = spyOnRebindAudit(manager);
    const result = await manager.reconcileInReviewBranchRebind({ includeTaskIds: new Set([id]) });
    const updated = await store.getTask(id);

    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: id, result: "skipped", reason: "unsafe-to-auto-mutate:checked-out" }),
    ]));
    expect(updated?.branch).toBe(brokenBranch);
    expect(updated?.branch).not.toBe(branch);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      taskId: id,
      mutationType: "task:auto-rebind-skipped",
      metadata: expect.objectContaining({
        reason: "unsafe-to-auto-mutate:checked-out",
        branch,
      }),
    }));
  });

  it("metadata-repairs safe autoMerge false in-review tasks without lifecycle mutation", async () => {
    const id = await createTaskInReview("manual merge metadata repair");
    const branch = await createUniqueFusionBranch(id, "manual-merge");
    const mainSha = git(rootDir, "rev-parse main");
    await store.updateTask(id, { branch: null, worktree: null, baseCommitSha: mainSha, autoMerge: false });

    const manager = new SelfHealingManager(store, { rootDir });
    const result = await manager.reconcileInReviewBranchRebind({ includeTaskIds: new Set([id]) });
    const updated = await store.getTask(id);

    expect(result.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: id, result: "applied", branch })]));
    expect(updated?.branch).toBe(branch);
    expect(updated?.column).toBe("in-review");
    expect(updated?.status).not.toBe("failed");
    expect(updated?.paused).not.toBe(true);
    expect(updated?.baseCommitSha).toBe(mainSha);
  });

  it("preserves FN-4962 ordering with metadata reconcile before rebind", async () => {
    const id = await createTaskInReview("ordering");
    const branch = await createUniqueFusionBranch(id, "ordering");
    await store.updateTask(id, { branch: null, worktree: `${rootDir}/.worktrees/missing-${id.toLowerCase()}` });

    const manager = new SelfHealingManager(store, { rootDir });
    await (manager as any).reconcileTaskWorktreeMetadata({ includeTaskIds: new Set([id]) });
    const result = await manager.reconcileInReviewBranchRebind({ includeTaskIds: new Set([id]) });
    const updated = await store.getTask(id);

    expect(result.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: id, result: "applied", branch })]));
    expect(updated?.branch).toBe(branch);
    expect(updated?.worktree ?? null).toBeNull();
  });

  it("handles FN-5072-style contamination-cleared metadata with live unique branch", async () => {
    const id = await createTaskInReview("contamination-cleared");
    const branch = await createUniqueFusionBranch(id, "contamination");
    await store.updateTask(id, { branch: null, worktree: null, baseCommitSha: null });

    const manager = new SelfHealingManager(store, { rootDir });
    const result = await manager.reconcileInReviewBranchRebind({ includeTaskIds: new Set([id]) });
    const updated = await store.getTask(id);

    expect(result.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: id, result: "applied", branch })]));
    expect(updated?.baseCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("preserves no-live-branch skip outcome", async () => {
    const id = await createTaskInReview("no live branch");
    await store.updateTask(id, { branch: null, worktree: null });

    const manager = new SelfHealingManager(store, { rootDir });
    const audit = spyOnRebindAudit(manager);
    const result = await manager.reconcileInReviewBranchRebind({ includeTaskIds: new Set([id]) });

    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: id, result: "skipped", reason: "no-live-branch" }),
    ]));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      taskId: id,
      mutationType: "task:auto-rebind-skipped",
      metadata: expect.objectContaining({ reason: "no-live-branch" }),
    }));
  });

  it("preserves no-unique-work skip outcome", async () => {
    const id = await createTaskInReview("no unique work");
    const branch = `fusion/${id.toLowerCase()}`;
    git(rootDir, `branch ${branch} main`);
    await store.updateTask(id, { branch: null, worktree: null });

    const manager = new SelfHealingManager(store, { rootDir });
    const audit = spyOnRebindAudit(manager);
    const result = await manager.reconcileInReviewBranchRebind({ includeTaskIds: new Set([id]) });

    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: id, result: "skipped", reason: "no-unique-work" }),
    ]));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      taskId: id,
      mutationType: "task:auto-rebind-skipped",
      metadata: expect.objectContaining({ reason: "no-unique-work" }),
    }));
  });

  it("skips ambiguous case-variant candidates when filesystem permits both refs", async () => {
    const id = await createTaskInReview("ambiguous");
    const lower = `fusion/${id.toLowerCase()}`;
    const upper = `fusion/${id}`;

    git(rootDir, `checkout -b ${lower}`);
    writeFileSync(join(rootDir, `${id}-lower.txt`), "lower\n");
    git(rootDir, `add ${id}-lower.txt`);
    git(rootDir, "commit -m 'lower unique commit'");

    let caseVariantCreated = true;
    try {
      git(rootDir, `checkout -b ${upper} main`);
      writeFileSync(join(rootDir, `${id}-upper.txt`), "upper\n");
      git(rootDir, `add ${id}-upper.txt`);
      git(rootDir, "commit -m 'upper unique commit'");
    } catch {
      caseVariantCreated = false;
    }
    git(rootDir, "checkout main");
    await store.updateTask(id, { branch: null, worktree: null });

    const manager = new SelfHealingManager(store, { rootDir });
    const result = await manager.reconcileInReviewBranchRebind({ includeTaskIds: new Set([id]) });

    if (caseVariantCreated) {
      expect(result.outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskId: id, result: "skipped", reason: "ambiguous-candidates" }),
      ]));
    } else {
      expect(result.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: id })]));
    }
  });

  it("fires targeted rebind from task:moved to in-review listener", async () => {
    const id = await createTaskInReview("listener");
    const manager = new SelfHealingManager(store, { rootDir });
    const spy = vi.spyOn(manager, "reconcileInReviewBranchRebind").mockResolvedValue({ repaired: 0, outcomes: [] });
    manager.start();
    const task = await store.getTask(id);
    if (!task) throw new Error("task missing");

    store.emit("task:moved", { task, from: "todo", to: "in-review", source: "engine" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy).toHaveBeenCalledWith({ includeTaskIds: new Set([id]) });
    manager.stop();
  });
});
