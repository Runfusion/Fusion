/*
FNXC:WorkspaceLateAcquire 2026-08-24-06:11:
R9-R13: the two-tier late-acquire gate. Tier 2 (landing has begun) is absolute; tier 1 re-admits a
task merely sitting in a review column with nothing landed, at the price of a forced Code Review
re-entry. The invariant this file exists to protect is the ORDERING: the reroute strictly follows a
successful acquire, and the classifier's authoritative call is the one inside the acquisition lock —
so a `landedSha` appearing between the outer and inner check refuses without ever rerouting.

The TaskStore is a narrow in-memory fake (FN-5048): the gate's inputs are task state, workflow IR
resolution, workflow selection, and the continuation seam, none of which need a database.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateSupersededRepositoryScopeReviews, type Task } from "@fusion/core";

const acquisition = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("../worktree/worktree-acquisition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/worktree-acquisition.js")>();
  return { ...actual, acquireWorkspaceRepoWorktree: acquisition.acquire };
});

import { createAcquireRepoWorktreeTool } from "../agent-tools.js";
import { TaskExecutor } from "../executor.js";
import { buildRunImplementationDeps } from "../executor/deps-bags.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";

type Fake = {
  task: any;
  store: any;
  logs: string[];
  audits: any[];
  seeds: any[];
  setSeedIdle: (seeded: boolean) => void;
};

/** A task in a review column that IS review-evidenced, i.e. tier-1 eligible. */
function reviewEvidencedTask(overrides: Partial<Task> = {}): any {
  return {
    id: "FN-9300",
    column: "in-review",
    enabledWorkflowSteps: ["code-review"],
    workspaceWorktrees: { "repo-a": { worktreePath: "/w/repo-a", branch: "fusion/fn-9300" } },
    ...overrides,
  };
}

function makeFake(task: any, options: { selection?: any; ir?: any } = {}): Fake {
  const logs: string[] = [];
  const audits: any[] = [];
  const seeds: any[] = [];
  let seedIdle = true;
  const store = {
    getTask: vi.fn(async () => task),
    logEntry: vi.fn(async (_id: string, message: string) => { logs.push(message); }),
    recordRunAuditEvent: vi.fn(async (event: any) => { audits.push(event); }),
    mutateTaskRepositoryScope: vi.fn(async (_id: string, request: any) => {
      task.repositoryScope = {
        state: "confirmed",
        revision: (task.repositoryScope?.revision ?? 0) + 1,
        repositories: [...new Set([...(task.repositoryScope?.repositories ?? []), ...request.repositories])],
        // Mirrors the production mutation: a scope change clears the WHOLE evidence map (OQ3/R13).
        reviewEvidence: undefined,
      };
      return task;
    }),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async (input: any) => {
      seeds.push(input);
      return { seeded: seedIdle };
    }),
    /*
    The IR seam: a selection naming a workflow id plus its definition is how production resolves a
    task's IR, so a test that needs a traitless or unselected-node workflow injects it here rather
    than stubbing the resolver.
    */
    getTaskWorkflowSelection: vi.fn(() => options.selection ?? { workflowId: "builtin:coding", stepIds: ["code-review"] }),
    getTaskWorkflowSelectionAsync: vi.fn(async () => options.selection ?? { workflowId: "builtin:coding", stepIds: ["code-review"] }),
    getWorkflowDefinition: vi.fn(async (id: string) => (options.ir && id === options.selection?.workflowId ? { ir: options.ir } : undefined)),
  } as any;
  return { task, store, logs, audits, seeds, setSeedIdle: (value: boolean) => { seedIdle = value; } };
}

function toolFor(fake: Fake, extra: Record<string, unknown> = {}) {
  return createAcquireRepoWorktreeTool({
    workspaceRootDir: "/workspace",
    workspaceRepos: ["repo-a", "repo-b"],
    task: fake.task,
    store: fake.store,
    settings: {},
    logger: { log: () => {}, warn: () => {} },
    ...extra,
  } as any);
}

function acquireSucceeds(): void {
  acquisition.acquire.mockImplementation(async (options: any) => {
    await options.validateTaskBeforeCreate?.(await options.store.getTask(options.task.id));
    return { worktreePath: "/w/repo-b", branch: "fusion/fn-9300", alreadyAcquired: false };
  });
}

describe("workspace late repository acquisition tiers", () => {
  beforeEach(() => { acquisition.acquire.mockReset(); });

  it("admits a review-column task with nothing landed, records the extension, and reroutes to Code Review", async () => {
    acquireSucceeds();
    const fake = makeFake(reviewEvidencedTask());

    const result = await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    expect(result.isError).not.toBe(true);
    expect(acquisition.acquire).toHaveBeenCalledWith(expect.objectContaining({ repoRelPath: "repo-b" }));
    expect(fake.store.mutateTaskRepositoryScope).toHaveBeenCalledTimes(1);
    expect(fake.seeds).toHaveLength(1);
    expect(fake.seeds[0]).toMatchObject({ taskId: "FN-9300", nodeId: "code-review" });
    expect((result.details as any).reviewReentry).toMatchObject({ rerouted: true, reason: "seeded" });
    expect(result.content[0]?.text).toContain("re-reviewed");
  });

  it("emits exactly one scope-extension audit row carrying ids and counts only", async () => {
    acquireSucceeds();
    const fake = makeFake(reviewEvidencedTask());

    await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    const rows = fake.audits.filter((event) => event.mutationType === "task:workspace-scope-extended-post-review");
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe("FN-9300");
    expect(Object.keys(rows[0].metadata).sort()).toEqual(["column", "repo", "repositoryCount", "taskId"]);
    expect(JSON.stringify(rows[0].metadata)).not.toContain("Executor acquired");
  });

  it("refuses once any repository has landed, naming the follow-up-task path", async () => {
    const fake = makeFake(reviewEvidencedTask({
      workspaceWorktrees: { "repo-a": { worktreePath: "/w/repo-a", branch: "b", landedSha: "abc123" } } as any,
    }));

    const refused = await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    expect(refused).toMatchObject({ isError: true });
    expect(refused.content[0]?.text).toContain("follow-up task");
    expect((refused.details as any).lateAcquireRefusalReason).toBe("already-landed");
    expect(acquisition.acquire).not.toHaveBeenCalled();
  });

  it("refuses every merging and workspace-review-required status", async () => {
    for (const status of ["merging", "merging-pr", "merging-fix", "workspace-review-required"]) {
      const fake = makeFake(reviewEvidencedTask({ status } as any));
      const refused = await toolFor(fake).execute("call", { repo: "repo-b" } as never);
      expect(refused, status).toMatchObject({ isError: true });
      expect((refused.details as any).lateAcquireRefusalReason, status).toBe("merging");
      expect(acquisition.acquire).not.toHaveBeenCalled();
    }
  });

  it("refuses a pending or active merge through the injected predicate, not a status read", async () => {
    const fake = makeFake(reviewEvidencedTask());

    const refused = await toolFor(fake, { isMergePendingOrActive: async () => true })
      .execute("call", { repo: "repo-b" } as never);

    expect(refused).toMatchObject({ isError: true });
    expect((refused.details as any).lateAcquireRefusalReason).toBe("merge-pending");
    expect(fake.task.status).toBeUndefined();
    expect(acquisition.acquire).not.toHaveBeenCalled();
  });

  it("degrades to the status-only check when no merge-pending provider is wired", async () => {
    acquireSucceeds();
    const fake = makeFake(reviewEvidencedTask());

    const result = await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    expect(result.isError).not.toBe(true);
  });

  it("carries the predicate from a real engine construction, not only a test opts bag", async () => {
    const executor = new TaskExecutor({ getTask: vi.fn(), on: vi.fn(), off: vi.fn(), once: vi.fn() } as any, "/root", {} as any);
    executor.setMergePendingProvider(async (taskId: string) => taskId === "FN-9300");
    const deps = buildRunImplementationDeps(executor, { BRANCH_CONFLICT_TRIPWIRE_THRESHOLD: 1, MAX_AUTO_RECOVERY_ATTEMPTS: 1 });

    await expect(deps.isTaskMergePendingOrActive("FN-9300")).resolves.toBe(true);
    await expect(deps.isTaskMergePendingOrActive("FN-OTHER")).resolves.toBe(false);

    // The runtime must forward both late-bound providers to the executor it owns, or the seam above
    // is wired in tests and unwired in production.
    const runtimeLike: any = Object.create(InProcessRuntime.prototype);
    runtimeLike.executor = { setMergePendingProvider: vi.fn(), setActiveMergeTaskIdProvider: vi.fn() };
    const provider = async () => true;
    const activeProvider = () => "FN-9300";
    InProcessRuntime.prototype.setMergePendingProvider.call(runtimeLike, provider);
    InProcessRuntime.prototype.setActiveMergeTaskIdProvider.call(runtimeLike, activeProvider);
    expect(runtimeLike.executor.setMergePendingProvider).toHaveBeenCalledWith(provider);
    expect(runtimeLike.executor.setActiveMergeTaskIdProvider).toHaveBeenCalledWith(activeProvider);

    /*
    Structural half of the same seam (a code-construct guard, not a prose assertion): ProjectEngine
    registers both providers BEFORE start() creates the executor, so the forwarding above only
    covers the late-registration direction. Without the construction-time re-apply the production
    executor would be built with no providers at all and tier 2 would degrade to a status-only check
    forever — the "resolved seam nobody wired" failure this test exists to prevent.
    */
    const runtimeSource = readFileSync(join(import.meta.dirname, "..", "runtimes", "in-process-runtime.ts"), "utf8");
    const constructionBlock = runtimeSource.slice(runtimeSource.indexOf("this.executor = new TaskExecutor("));
    expect(constructionBlock.slice(0, 1200)).toContain("setMergePendingProvider(this.mergePendingProvider)");
    expect(constructionBlock.slice(0, 1200)).toContain("setActiveMergeTaskIdProvider(this.activeMergeTaskIdProvider)");
  });

  it("refuses a complete or archived column even with nothing landed", async () => {
    for (const column of ["done", "archived"]) {
      const fake = makeFake(reviewEvidencedTask({ column } as any));
      const refused = await toolFor(fake).execute("call", { repo: "repo-b" } as never);
      expect(refused, column).toMatchObject({ isError: true });
      expect((refused.details as any).lateAcquireRefusalReason, column).toBe("not-a-review-column");
      expect(acquisition.acquire).not.toHaveBeenCalled();
    }
  });

  it("refuses a literal in-review column whose workflow resolves no review columns", async () => {
    // A traitless IR: resolveReviewColumns returns [], so the literal blocked set is the only guard
    // and the task must NOT fall through both tiers into unrestricted acquisition.
    const fake = makeFake(reviewEvidencedTask(), {
      selection: { workflowId: "custom:traitless", stepIds: ["code-review"] },
      ir: {
        version: "v2",
        name: "traitless",
        columns: [{ id: "in-review", name: "Review", traits: [] }],
        nodes: [{ id: "code-review", kind: "optional-group", column: "in-review", config: { defaultOn: true, reviewKind: "code" } }],
      },
    });

    const refused = await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    expect(refused).toMatchObject({ isError: true });
    expect((refused.details as any).lateAcquireRefusalReason).toBe("not-a-review-column");
    expect(acquisition.acquire).not.toHaveBeenCalled();
  });

  it("refuses before acquiring when the task carries no review evidence", async () => {
    const fake = makeFake(reviewEvidencedTask({ enabledWorkflowSteps: [] as any }));

    const refused = await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    expect((refused.details as any).lateAcquireRefusalReason).toBe("no-review-evidence");
    expect(acquisition.acquire).not.toHaveBeenCalled();
    expect(fake.store.mutateTaskRepositoryScope).not.toHaveBeenCalled();
  });

  it("admits a task whose evidence comes from a recorded reviewEvidence map", async () => {
    acquireSucceeds();
    const fake = makeFake(reviewEvidencedTask({
      enabledWorkflowSteps: [] as any,
      repositoryScope: { state: "confirmed", revision: 3, repositories: ["repo-a"], reviewEvidence: {} } as any,
    }));

    const result = await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    expect(result.isError).not.toBe(true);
  });

  it("refuses before acquiring when the workflow has no Code Review node at all", async () => {
    const fake = makeFake(reviewEvidencedTask(), {
      selection: { workflowId: "custom:no-code-review", stepIds: ["plan-review"] },
      ir: {
        version: "v2",
        name: "no-code-review",
        columns: [{ id: "in-review", name: "Review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] }],
        nodes: [{ id: "plan-review", kind: "optional-group", column: "in-review", config: { defaultOn: true, reviewKind: "plan" } }],
      },
    });

    const refused = await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    expect(refused).toMatchObject({ isError: true });
    expect((refused.details as any).lateAcquireRefusalReason).toBe("no-code-review-route");
    expect(acquisition.acquire).not.toHaveBeenCalled();
    expect(fake.store.mutateTaskRepositoryScope).not.toHaveBeenCalled();
    expect(fake.seeds).toHaveLength(0);
  });

  it("keeps the acquisition when post-acquire bookkeeping throws, and reports the pending re-entry", async () => {
    acquireSucceeds();
    const fake = makeFake(reviewEvidencedTask());
    let reads = 0;
    const realGetTask = fake.store.getTask;
    fake.store.getTask = vi.fn(async (id: string) => {
      // The post-acquire re-read is the one that fails; the acquisition itself already succeeded.
      if (++reads > 2) throw new Error("task read failed mid-bookkeeping");
      return realGetTask(id);
    });

    const result = await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    expect(result.isError).not.toBe(true);
    expect((result.details as any).worktreePath).toBe("/w/repo-b");
    expect(result.content[0]?.text).toContain("pending");
  });

  it("treats a throwing merge-pending provider as not merge-pending rather than crashing", async () => {
    acquireSucceeds();
    const fake = makeFake(reviewEvidencedTask());

    const result = await toolFor(fake, { isMergePendingOrActive: () => { throw new Error("provider exploded"); } })
      .execute("call", { repo: "repo-b" } as never);

    expect(result.isError).not.toBe(true);
  });

  it("refuses before acquiring when the Code Review node is neither defaultOn nor selected", async () => {
    // The reroute itself returns no-code-review-route for a present-but-unselected node, so the
    // pre-acquire probe must replicate that whole condition rather than node presence alone.
    const fake = makeFake(reviewEvidencedTask(), {
      selection: { workflowId: "custom:unselected", stepIds: ["plan-review"] },
      ir: {
        version: "v2",
        name: "unselected-code-review",
        columns: [{ id: "in-review", name: "Review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] }],
        nodes: [{ id: "code-review", kind: "optional-group", column: "in-review", config: { defaultOn: false, reviewKind: "code" } }],
      },
    });

    const refused = await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    expect(refused).toMatchObject({ isError: true });
    expect((refused.details as any).lateAcquireRefusalReason).toBe("no-code-review-route");
    expect(acquisition.acquire).not.toHaveBeenCalled();
    expect(fake.seeds).toHaveLength(0);
  });

  it("refuses in the inner check when a landedSha appears between the two checks, and never reroutes", async () => {
    const fake = makeFake(reviewEvidencedTask());
    acquisition.acquire.mockImplementation(async (options: any) => {
      fake.task.workspaceWorktrees["repo-a"].landedSha = "raced-sha";
      await options.validateTaskBeforeCreate?.(fake.task);
      return { worktreePath: "/w/repo-b", branch: "fusion/fn-9300", alreadyAcquired: false };
    });

    const refused = await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    expect(refused).toMatchObject({ isError: true });
    expect((refused.details as any).lateAcquireRefusalReason).toBe("already-landed");
    expect(fake.seeds).toHaveLength(0);
    expect(fake.audits.filter((event) => event.mutationType === "task:workspace-scope-extended-post-review")).toHaveLength(0);
  });

  it("treats an existing active continuation as a successful re-entry", async () => {
    acquireSucceeds();
    const fake = makeFake(reviewEvidencedTask());
    fake.setSeedIdle(false);

    const result = await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    expect(result.isError).not.toBe(true);
    expect((result.details as any).reviewReentry).toMatchObject({ rerouted: false, reason: "active-continuation" });
    expect(result.content[0]?.text).toContain("active-continuation");
  });

  it("keeps the acquisition when the reroute fails, and names the pending re-entry", async () => {
    acquireSucceeds();
    const fake = makeFake(reviewEvidencedTask());
    fake.store.seedWorkspaceCodeReviewContinuationIfIdle = vi.fn(async () => { throw new Error("continuation slot contended"); });

    const result = await toolFor(fake).execute("call", { repo: "repo-b" } as never);

    expect(result.isError).not.toBe(true);
    expect(fake.store.mutateTaskRepositoryScope).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toContain("pending");
    expect((result.details as any).worktreePath).toBe("/w/repo-b");
    expect(fake.logs.some((line) => line.includes("could NOT seed Code Review re-entry"))).toBe(true);
  });

  it("produces one continuation for two acquisitions in the same tick", async () => {
    acquireSucceeds();
    const fake = makeFake(reviewEvidencedTask());
    let seeded = 0;
    fake.store.seedWorkspaceCodeReviewContinuationIfIdle = vi.fn(async () => ({ seeded: seeded++ === 0 }));
    const tool = toolFor(fake);

    const [first, second] = await Promise.all([
      tool.execute("call-1", { repo: "repo-b" } as never),
      tool.execute("call-2", { repo: "repo-b" } as never),
    ]);

    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    const reasons = [(first.details as any).reviewReentry?.reason, (second.details as any).reviewReentry?.reason].sort();
    expect(reasons).toEqual(["active-continuation", "seeded"]);
  });

  it("re-reviews every repository in scope, not only the newly acquired one (R13 cost)", () => {
    const results = [
      { reviewKind: "code", repositoryScopeRevision: 4, status: "done", verdict: "approve", output: "repo-a approved" },
      { reviewKind: "code", repositoryScopeRevision: 4, status: "done", verdict: "approve", output: "repo-c approved" },
      { reviewKind: "plan", repositoryScopeRevision: 4, status: "done", verdict: "approve", output: "plan approved" },
    ] as any;

    const invalidated = invalidateSupersededRepositoryScopeReviews(results, 5) as any[];

    expect(invalidated.filter((r) => r.reviewKind === "code").every((r) => r.status === "failed" && r.verdict === undefined)).toBe(true);
    expect(invalidated.find((r) => r.reviewKind === "plan")).toMatchObject({ status: "done", verdict: "approve" });
  });
});
