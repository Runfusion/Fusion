import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, WorkflowIr, WorkflowWorkItem } from "@fusion/core";
import { planningContinuationDispatchLeaseOwner } from "../agents/planning-execution-liveness.js";
import { blockOuterDispatchWhenDependenciesUnmet } from "../executor/dependency-dispatch-gate.js";
import { blockOuterDispatchWhenFileScopeLeaseHeld } from "../executor/file-scope-lease-dispatch-gate.js";
import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import { synchronizeOverlapWaitBeforeExecution } from "../executor/overlap-resume-gate.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { revalidatePendingOverlapWaitsAtGraphNode } from "../workflows/overlap-plan-revalidation.js";
import { createPlanningContinuationDispatcher, createRuntimeSelfHealingManager } from "../runtimes/in-process-runtime.js";
import { finalizeMerged } from "../merge/merger-ai.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), "fn-332-production-chain-"));
  cleanup.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "fusion@example.test");
  git(root, "config", "user.name", "Fusion Test");
  writeFileSync(join(root, "shared.txt"), "export const contract = 'stable';\n");
  git(root, "add", "shared.txt");
  git(root, "commit", "-m", "C0");
  const c0 = git(root, "rev-parse", "HEAD");
  const worktree = join(root, ".worktrees", "fn-b");
  mkdirSync(join(root, ".worktrees"), { recursive: true });
  git(root, "worktree", "add", "-b", "fusion/fn-b", worktree, c0);
  writeFileSync(join(root, "shared.txt"), "export const contract = 'stable';\n// C1\n");
  git(root, "add", "shared.txt");
  git(root, "commit", "-m", "feat(FN-A): deliver C1");
  const c1 = git(root, "rev-parse", "HEAD");
  const holderWorktree = join(root, ".worktrees", "fn-a");
  git(root, "worktree", "add", "-b", "fusion/fn-a", holderWorktree, c1);
  return { root, worktree, holderWorktree, c0, c1 };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: "",
    prompt: "## Mission\nImprove the implementation detail.\n\n## File Scope\n- `shared.txt`\n\n## Steps\n\n### Step 0: Work\nApply the requested polish.",
    column: "todo",
    dependencies: [],
    steps: [{ name: "Completed preparation", status: "done" }],
    currentStep: 1,
    log: [],
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function continuation(taskId: string): WorkflowWorkItem {
  return {
    id: "wi-overlap-resume", runId: `${taskId}:builtin:coding:plan-review`, stableWorkflowRunId: `${taskId}:builtin:coding`,
    taskId, nodeId: "plan-review", nodeInstanceId: "plan-review", kind: "task", state: "runnable",
    attempt: 0, retryAfter: null, leaseOwner: null, leaseExpiresAt: null, lastError: null, blockedReason: null,
    continuationSequence: 1, waitReason: "planning", sourceColumn: "todo", targetColumn: "todo",
    irHash: "fn-332-ir", principalAgentId: null, workflowRole: null, authorityKind: null,
    createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
  } as WorkflowWorkItem;
}

function createProductionStore(blocked: Task, holder: Task) {
  const emitter = new EventEmitter();
  const tasks = new Map([[blocked.id, blocked], [holder.id, holder]]);
  const episodes: any[] = [];
  let episode: any;
  let item = continuation(blocked.id);
  let releaseSettlement: (() => void) | undefined;
  let settlementBarrier: Promise<void> | undefined;
  const store: any = Object.assign(emitter, {
    getRootDir: vi.fn(() => "/repo"),
    getTasksDir: vi.fn(() => "/repo/.fusion/tasks"),
    getSettings: vi.fn(async () => ({ autoMerge: true, groupOverlappingFiles: true, overlapIgnorePaths: [], refreshWorktreeBaseBeforeExecution: true, maxConcurrent: 4 })),
    listTasks: vi.fn(async () => [...tasks.values()]),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    parseFileScopeFromPrompt: vi.fn(async () => ["shared.txt"]),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    listWorkflowDefinitions: vi.fn(async () => []),
    listWorkflowWorkItemsForTask: vi.fn(async () => [item]),
    listDueWorkflowWorkItems: vi.fn(async () => item.state === "runnable" || item.state === "retrying" ? [item] : []),
    getWorkflowWorkItem: vi.fn(async () => item),
    transitionWorkflowWorkItem: vi.fn(async (_id: string, state: WorkflowWorkItem["state"], patch: any = {}) => {
      if ((patch.expectedState === undefined || item.state === patch.expectedState)
        && (patch.expectedLeaseOwner === undefined || item.leaseOwner === patch.expectedLeaseOwner)) {
        const { expectedState: _state, expectedLeaseOwner: _owner, ...updates } = patch;
        item = { ...item, ...updates, state };
      }
      return item;
    }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
    transitionQueuedEpisode: vi.fn(async (id: string, input: any) => {
      const live = tasks.get(id)!;
      const blockerId = input.overlapBlockedBy?.trim();
      const next = { ...live, status: blockerId ? "queued" : null, overlapBlockedBy: blockerId ?? null } as Task;
      tasks.set(id, next);
      if (blockerId && episode?.blockerTaskId !== blockerId) {
        episode = { projectId: "project", taskId: id, episodeId: `episode-${blockerId.toLowerCase()}`, blockerTaskId: blockerId, observedAt: new Date().toISOString(), phase: "observed", revision: 1, attempt: 0, observation: {} };
        episodes.push(episode);
      }
      if (settlementBarrier) await settlementBarrier;
      return { appended: true, task: next };
    }),
    publishTaskOverlapDeliveries: vi.fn(async (blockerTaskId: string, deliveries: any[]) => {
      let published = 0;
      for (let index = 0; index < episodes.length; index++) {
        const candidate = episodes[index];
        if (candidate.blockerTaskId !== blockerTaskId || candidate.phase === "delivered") continue;
        const updated = { ...candidate, revision: candidate.revision + 1, observation: { ...candidate.observation, deliveries } };
        episodes[index] = updated;
        if (episode?.episodeId === updated.episodeId) episode = updated;
        published++;
      }
      return published;
    }),
    listTaskOverlapWaits: vi.fn(async (_id: string, options?: { pendingOnly?: boolean }) => options?.pendingOnly && episode?.phase === "delivered" ? [] : episode ? [episode] : []),
    claimTaskOverlapWait: vi.fn(async (claim: any) => {
      if (!episode || claim.expectedRevision !== episode.revision) return null;
      episode = { ...episode, phase: "analyzing", owner: claim.owner, revision: episode.revision + 1, attempt: episode.attempt + 1, observation: { ...episode.observation, executionIdentity: claim.executionIdentity } };
      return episode;
    }),
    completeTaskOverlapWait: vi.fn(async (input: any) => {
      if (!episode || input.expectedRevision !== episode.revision || input.owner !== episode.owner) return null;
      episode = { ...episode, phase: input.phase, receipt: input.receipt, revision: episode.revision + 1 };
      return episode;
    }),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const next = { ...tasks.get(id)!, ...patch } as Task;
      tasks.set(id, next);
      return next;
    }),
    updateTaskAtomic: vi.fn(async (id: string, build: (live: Task) => Partial<Task> | null) => {
      const live = tasks.get(id)!;
      const patch = build(live);
      if (patch) tasks.set(id, { ...live, ...patch } as Task);
      return tasks.get(id);
    }),
    moveTask: vi.fn(async (id: string, column: string) => {
      const previous = tasks.get(id)!;
      const next = { ...previous, column } as Task;
      tasks.set(id, next);
      emitter.emit("task:moved", { task: next, from: previous.column, to: column, source: "engine", lanes: { review: new Set(["in-review"]), complete: new Set(["done"]) } });
      return next;
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
  });
  return {
    store,
    blockSettlement() {
      settlementBarrier = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    },
    settle() { releaseSettlement?.(); settlementBarrier = undefined; },
    addTask(value: Task) { tasks.set(value.id, value); },
    get episode() { return episode; },
    get episodes() { return episodes; },
    get blocked() { return tasks.get(blocked.id)!; },
    get item() { return item; },
  };
}

async function finalizeHolder(store: any, repo: ReturnType<typeof createRepository>, holder: Task) {
  const audit = new Proxy({}, { get: () => vi.fn(async () => undefined) }) as any;
  return finalizeMerged(store, repo.root, holder.id, holder, "fusion/fn-a", "main", repo.c1, audit, async () => undefined, { empty: false });
}

describe("overlap resume production chain", () => {
  it.each(["delivery-first", "settlement-first", "restart-after-finalize"] as const)("uses the real terminal finalizer, FN-329 fan-out, durable drain, refresh, and transport (%s)", async (order) => {
    const repo = createRepository();
    const blocked = task("FN-B", { baseBranch: "main", baseCommitSha: repo.c0 });
    const holder = task("FN-A", { column: "in-review", autoMerge: true, worktree: repo.holderWorktree, branch: "fusion/fn-a", summary: "Changed the shared contract" });
    const h = createProductionStore(blocked, holder);
    let transportPrompt = "";
    let graphEntries = 0;
    let dispatchError: unknown;
    let dispatch!: (task: Task, item: WorkflowWorkItem) => Promise<boolean>;
    const kick = vi.fn(() => { if (h.item.state === "runnable") void dispatch(h.blocked, h.item); });
    dispatch = createPlanningContinuationDispatcher({
      store: h.store,
      projectId: "fn-332-project",
      isPlannerLive: () => false,
      kick,
      onError: (_task, _item, error) => { dispatchError = error; },
      execute: async (candidate) => {
        if (await blockOuterDispatchWhenDependenciesUnmet({ store: h.store, getRunContextFor: () => undefined }, candidate)) return;
        if (await blockOuterDispatchWhenFileScopeLeaseHeld({ store: h.store, getRunContextFor: () => undefined }, candidate)) return;
        graphEntries++;
        const acquisition = await acquireTaskWorktree({ task: h.blocked, rootDir: repo.root, store: h.store, settings: { refreshWorktreeBaseBeforeExecution: true } as any, runInitCommand: false });
        expect(h.episode).toMatchObject({ phase: "revalidation-pending", receipt: { decision: "revalidate", briefing: expect.stringContaining("FN-A") } });
        const executeWorkflowStep = vi.fn(async (_live: Task, step: any) => { transportPrompt = step.prompt; return { success: true, output: "done" }; });
        const customDeps = {
          store: h.store, rootDir: repo.root, workspaceConfig: null, options: {}, graphUnattendedRuns: new Set(), getRunContextFor: () => undefined,
          adoptColumnAgentForNode: vi.fn(async () => undefined), buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
          ensureGraphCustomNodeWorktree: vi.fn(async () => h.blocked), executeScriptWorkflowStep: vi.fn(), executeWorkflowStep,
          pauseForCliApproval: vi.fn(), resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined), runAwaitInputNode: vi.fn(), runCliAgentNode: vi.fn(), runRawCliCommand: vi.fn(), runConfiguredCommand: vi.fn(),
        } as any;
        const graph = new WorkflowGraphExecutor({
          handlers: { prompt: (node, context) => runGraphCustomNode(customDeps, node, context.task, {}, undefined, context) },
          beforeNodeExecution: async (node) => {
            const outcome = await revalidatePendingOverlapWaitsAtGraphNode({
              task: h.blocked,
              store: h.store,
              nodeId: node.id,
              review: async () => ({ success: true, verdict: "APPROVE" }),
              repair: async () => false,
            });
            return outcome === "approved" || outcome === "not-required" ? undefined : { outcome: "failure", value: `overlap-plan-revalidation-${outcome}` };
          },
        });
        const ir: WorkflowIr = { version: "v2", name: "overlap-production-chain", columns: [{ id: "todo", name: "Ready", traits: [] }], nodes: [{ id: "start", kind: "start" }, { id: "ordinary-custom-work", kind: "prompt", config: { prompt: "Continue implementation", toolMode: "coding" } }, { id: "end", kind: "end" }], edges: [{ from: "start", to: "ordinary-custom-work" }, { from: "ordinary-custom-work", to: "end" }] };
        await graph.run(h.blocked as any, { experimentalFeatures: { workflowGraphExecutor: true } }, ir);
        await h.store.transitionWorkflowWorkItem(h.item.id, "succeeded", { expectedState: "running", expectedLeaseOwner: planningContinuationDispatchLeaseOwner(h.item), leaseOwner: null, leaseExpiresAt: null });
        expect(acquisition.worktreePath).toBe(repo.worktree);
      },
    });
    const manager = createRuntimeSelfHealingManager(h.store, { requestImmediateSchedule: vi.fn() } as any, { rootDir: repo.root }, { kick });
    if (order !== "restart-after-finalize") manager.start();

    if (order === "delivery-first") h.blockSettlement();
    const initialDispatch = dispatch(blocked, h.item);
    if (order === "settlement-first") expect(await initialDispatch).toBe(true);
    await vi.waitFor(() => {
      if (dispatchError) throw dispatchError;
      expect(h.store.transitionQueuedEpisode).toHaveBeenCalledWith("FN-B", expect.objectContaining({ overlapBlockedBy: "FN-A" }));
    });
    await h.store.updateTask("FN-B", { worktree: repo.worktree, branch: "fusion/fn-b" });

    const finalization = await finalizeHolder(h.store, repo, holder);
    if (order === "delivery-first") { h.settle(); await initialDispatch; }
    if (order === "restart-after-finalize") {
      vi.spyOn(manager, "reclaimSelfOwnedBranchConflicts").mockResolvedValue(0);
      const startupOverlapCatchUp = vi.spyOn(manager, "clearStaleBlockedBy");
      manager.start();
      await manager.runStartupRecovery();
      expect(startupOverlapCatchUp).toHaveBeenCalledTimes(1);
    }

    await vi.waitFor(() => {
      if (dispatchError) throw dispatchError;
      expect(h.item.state).toBe("succeeded");
      expect(h.item.leaseOwner).toBeNull();
    });
    expect(graphEntries).toBe(1);
    expect(finalization.ok).toBe(true);
    expect(h.store.publishTaskOverlapDeliveries.mock.invocationCallOrder[0]).toBeLessThan(h.store.moveTask.mock.invocationCallOrder[0]);
    expect(h.item).toMatchObject({ state: "succeeded", leaseOwner: null });
    expect(git(repo.worktree, "merge-base", "--is-ancestor", repo.c1, "HEAD")).toBe("");
    expect(readFileSync(join(repo.worktree, "shared.txt"), "utf8")).toContain("C1");
    expect(transportPrompt).toContain("Changed the shared contract");
    expect(transportPrompt).toContain("shared.txt");
    expect(h.episode).toMatchObject({ phase: "delivered", receipt: { decision: "revalidate", freshness: "proven", revalidationVerdict: "APPROVE", contextDeliveredAt: expect.any(String) } });
    expect(h.blocked.steps[0]?.status).toBe("done");
    manager.stop();
  });

  it("does not let A's completion consume a replacement C overlap episode", async () => {
    const repo = createRepository();
    const blocked = task("FN-B", { baseBranch: "main", baseCommitSha: repo.c0 });
    const holder = task("FN-A", { column: "in-review", autoMerge: true, worktree: repo.holderWorktree, branch: "fusion/fn-a", summary: "Changed the shared contract" });
    const replacement = task("FN-C", { column: "in-progress" });
    const h = createProductionStore(blocked, holder);
    h.addTask(replacement);
    let ordinaryDispatches = 0;
    let dispatch!: (candidate: Task, item: WorkflowWorkItem) => Promise<boolean>;
    const kick = vi.fn(() => { if (h.item.state === "runnable") void dispatch(h.blocked, h.item); });
    dispatch = createPlanningContinuationDispatcher({
      store: h.store,
      projectId: "fn-332-project",
      isPlannerLive: () => false,
      kick,
      execute: async (candidate) => {
        if (await blockOuterDispatchWhenFileScopeLeaseHeld({ store: h.store, getRunContextFor: () => undefined }, candidate)) return;
        ordinaryDispatches++;
      },
    });
    const manager = createRuntimeSelfHealingManager(h.store, { requestImmediateSchedule: vi.fn() } as any, { rootDir: repo.root }, { kick });
    manager.start();

    expect(await dispatch(blocked, h.item)).toBe(true);
    await vi.waitFor(() => expect(h.item.state).toBe("held"));
    await h.store.transitionQueuedEpisode("FN-B", { overlapBlockedBy: "FN-C" });
    expect(h.blocked.overlapBlockedBy).toBe("FN-C");
    await finalizeHolder(h.store, repo, holder);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ordinaryDispatches).toBe(0);
    expect(h.item.state).toBe("held");
    expect(h.blocked.overlapBlockedBy).toBe("FN-C");
    expect(h.episodes.find((candidate: any) => candidate.blockerTaskId === "FN-A")).toMatchObject({ observation: { deliveries: expect.any(Array) } });
    expect(h.episodes.find((candidate: any) => candidate.blockerTaskId === "FN-C")).toMatchObject({ phase: "observed", observation: {} });
    manager.stop();
  });

  it("keeps the released continuation held while another dependency remains unmet", async () => {
    const repo = createRepository();
    const blocked = task("FN-B", { baseBranch: "main", baseCommitSha: repo.c0, dependencies: ["FN-D"] });
    const holder = task("FN-A", { column: "in-review", autoMerge: true, worktree: repo.holderWorktree, branch: "fusion/fn-a", summary: "Changed the shared contract" });
    const dependency = task("FN-D", { column: "todo" });
    const h = createProductionStore(blocked, holder);
    h.addTask(dependency);
    let ordinaryDispatches = 0;
    let dispatch!: (candidate: Task, item: WorkflowWorkItem) => Promise<boolean>;
    const kick = vi.fn(() => { if (h.item.state === "runnable") void dispatch(h.blocked, h.item); });
    dispatch = createPlanningContinuationDispatcher({
      store: h.store,
      projectId: "fn-332-project",
      isPlannerLive: () => false,
      kick,
      execute: async (candidate) => {
        if (await blockOuterDispatchWhenFileScopeLeaseHeld({ store: h.store, getRunContextFor: () => undefined }, candidate)) return;
        if (await blockOuterDispatchWhenDependenciesUnmet({ store: h.store, getRunContextFor: () => undefined }, candidate)) return;
        ordinaryDispatches++;
      },
    });
    const manager = createRuntimeSelfHealingManager(h.store, { requestImmediateSchedule: vi.fn() } as any, { rootDir: repo.root }, { kick });
    manager.start();

    expect(await dispatch(blocked, h.item)).toBe(true);
    await vi.waitFor(() => expect(h.item.state).toBe("held"));
    await finalizeHolder(h.store, repo, holder);
    await vi.waitFor(() => expect(h.blocked.blockedBy).toBe("FN-D"));

    expect(ordinaryDispatches).toBe(0);
    expect(h.blocked.overlapBlockedBy).toBeNull();
    expect(h.item.state).toBe("held");
    expect(h.blocked.dependencies).toEqual(["FN-D"]);
    manager.stop();
  });

  it.each([
    ["absent", undefined],
    ["throw", () => { throw new Error("sink down"); }],
    ["reject", () => Promise.reject(new Error("sink rejected"))],
    ["hang", () => new Promise(() => undefined)],
  ])("keeps a no-op owner decision unchanged with an %s audit sink", async (_label, audit) => {
    let revision = 1;
    const store = {
      listTaskOverlapWaits: vi.fn(async () => [{ taskId: "FN-B", episodeId: "ep-1", blockerTaskId: "FN-A", phase: "observed", revision, attempt: 0, observation: { deliveries: [{ blockerTaskId: "FN-A", repository: ".", noOp: true, paths: [], evidence: "merge-details" }] } }]),
      claimTaskOverlapWait: vi.fn(async ({ owner }) => ({ taskId: "FN-B", episodeId: "ep-1", blockerTaskId: "FN-A", phase: "analyzing", revision: ++revision, attempt: 1, owner })),
      completeTaskOverlapWait: vi.fn(async ({ owner, phase, receipt }) => ({ taskId: "FN-B", episodeId: "ep-1", blockerTaskId: "FN-A", phase, revision: ++revision, attempt: 1, owner, receipt })),
      getTask: vi.fn(async () => task("FN-B")),
      recordRunAuditEvent: audit ?? vi.fn(async () => undefined),
    } as any;
    await expect(synchronizeOverlapWaitBeforeExecution({ task: task("FN-B"), store, worktreePath: process.cwd(), owner: "graph-owner" })).resolves.toMatchObject({ analysis: { decision: "resume" } });
  });
});
