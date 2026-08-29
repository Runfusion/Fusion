import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { ActiveSessionRegistry } from "../agents/active-session-registry.js";
import { acquireWorkspaceRepoWorktree, WorkspacePreparationError, WorkspaceRepoAcquireBusyError } from "../worktree/worktree-acquisition.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const task = (id: string): Task => ({ id, title: id, description: "workspace", status: "in-progress" } as Task);
const settings = { worktreeNaming: "task-id", taskPrefix: "FN", taskAttributionTrailerNames: ["Fusion-Task-Id"] } as Partial<Settings>;
const describeIfGit = hasGit ? describe : describe.skip;

type Lease = { leaseKey: string; kind: "acquire"; taskId: string; expiresAt: number };

function makeLeaseStore(currentTask: Task, beforePersist?: () => Promise<void>) {
  const leases = new Map<string, Lease>();
  let current = currentTask;
  const store = {
    acquireWorkspaceLease: vi.fn(async (input: { leaseKey: string; kind: "acquire"; owner: { taskId: string }; leaseMs: number }) => {
      const existing = leases.get(input.leaseKey);
      if (existing && existing.expiresAt > Date.now() && existing.taskId !== input.owner.taskId) {
        return { outcome: "conflict", conflict: { taskId: existing.taskId } };
      }
      const handle = { leaseKey: input.leaseKey, kind: input.kind, taskId: input.owner.taskId, expiresAt: Date.now() + input.leaseMs } as Lease;
      leases.set(input.leaseKey, handle);
      return { outcome: existing ? "reclaimed-expired" : "acquired", handle };
    }),
    renewWorkspaceLease: vi.fn(async (lease: Lease, leaseMs: number) => {
      const currentLease = leases.get(lease.leaseKey);
      if (currentLease !== lease) return undefined;
      const renewed = { ...lease, expiresAt: Date.now() + leaseMs };
      leases.set(lease.leaseKey, renewed);
      return renewed;
    }),
    releaseWorkspaceLease: vi.fn(async (lease: Lease) => { if (leases.get(lease.leaseKey)?.taskId === lease.taskId) leases.delete(lease.leaseKey); }),
    getTask: vi.fn(async (id: string) => id === current.id ? current : null),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => { if (id === current.id) current = { ...current, ...patch }; }),
    logEntry: vi.fn(async () => undefined),
    mergeWorkspaceWorktreeEntry: vi.fn(async (_id: string, repo: string, patch: any) => {
      const resolved = typeof patch === "function" ? await patch(current) : patch;
      await beforePersist?.();
      current = { ...current, workspaceWorktrees: { ...current.workspaceWorktrees, [repo]: resolved } };
      return current;
    }),
  } as unknown as TaskStore;
  return { store, leases, current: () => current };
}

/**
 * FNXC:WorkspaceWorktree 2026-08-23-07:08:
 * FN-179 makes the durable acquire lease the admission authority. These use a
 * real Git workspace and an expiring lease fake so renewal and convergence are
 * exercised through the production acquisition path, not by source inspection.
 */
describeIfGit("workspace acquire durable lease authority", () => {
  let fixture: WorkspaceFixture;
  afterEach(() => { fixture?.cleanup(); vi.useRealTimers(); });

  it("reports the durable conflict holder without creating a derived registry claim", async () => {
    const registry = new ActiveSessionRegistry();
    const store = {
      acquireWorkspaceLease: vi.fn(async () => ({ outcome: "conflict", conflict: { taskId: "MRG-050" } })),
      logEntry: vi.fn(),
    } as unknown as TaskStore;

    await expect(acquireWorkspaceRepoWorktree({ repoRelPath: "Merge", workspaceRootDir: "/workspace", task: task("MRG-051"), store, settings, registry }))
      .rejects.toMatchObject<Partial<WorkspaceRepoAcquireBusyError>>({ name: "WorkspaceRepoAcquireBusyError", holderTaskId: "MRG-050" });
    expect(registry.lookupByPath("/workspace/Merge")).toBeNull();
  });

  it("admits a new owner when an expired durable lease has a stale same-process cache", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    vi.useFakeTimers();
    const durable = makeLeaseStore(task("MRG-050"));
    await (durable.store as any).acquireWorkspaceLease({ leaseKey: "repo:repo-a", kind: "acquire", owner: { taskId: "MRG-050" }, leaseMs: 5 * 60_000 });
    const registry = new ActiveSessionRegistry();
    const path = `${fixture.rootDir}/repo-a`;
    registry.registerPath(path, { taskId: "MRG-050", kind: "workspace-repo-acquire", ownerKey: "workspace-repo-acquire" });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

    const acquired = await acquireWorkspaceRepoWorktree({ repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: task("MRG-051"), store: durable.store, settings, registry, holderLiveProbe: () => true });

    expect(acquired.worktreePath).toContain(".worktrees");
    expect((durable.store as any).acquireWorkspaceLease).toHaveBeenCalledTimes(2);
    expect(registry.lookupByPath(path)).toBeNull();
  }, 30_000);

  it("renews a live acquisition past its lease TTL and keeps a second claimant out", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    let entered!: () => void;
    let release!: () => void;
    const enteredPreparation = new Promise<void>((resolve) => { entered = resolve; });
    const releasePreparation = new Promise<void>((resolve) => { release = resolve; });
    const first = makeLeaseStore(task("MRG-050"), async () => { entered(); await releasePreparation; });
    const registry = new ActiveSessionRegistry();
    vi.useFakeTimers();
    const acquiring = acquireWorkspaceRepoWorktree({ repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: first.current(), store: first.store, settings, registry });
    await enteredPreparation;

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect((first.store as any).renewWorkspaceLease).toHaveBeenCalled();
    const second = makeLeaseStore(task("MRG-051"));
    // Share the durable lease map: contention must be decided before local Git work.
    Object.assign(second.store as any, { acquireWorkspaceLease: (first.store as any).acquireWorkspaceLease });
    await expect(acquireWorkspaceRepoWorktree({ repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: task("MRG-051"), store: second.store, settings, registry: new ActiveSessionRegistry() }))
      .rejects.toMatchObject({ name: "WorkspaceRepoAcquireBusyError", holderTaskId: "MRG-050" });
    release();
    await acquiring;
    expect(first.leases.size).toBe(0);
  }, 30_000);

  it("fails closed when renewal is refused and releases the derived cache", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const holder = makeLeaseStore(task("MRG-050"), async () => new Promise<void>(() => undefined));
    (holder.store as any).renewWorkspaceLease.mockResolvedValue(undefined);
    const registry = new ActiveSessionRegistry();
    vi.useFakeTimers();
    const pending = acquireWorkspaceRepoWorktree({ repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: holder.current(), store: holder.store, settings, registry });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).rejects.toBeInstanceOf(WorkspacePreparationError);
    expect(registry.entriesByKind("workspace-repo-acquire")).toHaveLength(0);
    expect(holder.leases.size).toBe(0);
  }, 30_000);
});
