import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMockStore,
  mockedExec,
  mockedExecSync,
  mockedCreateFnAgent,
  setupHappyPathExecSync,
} from "./merger-test-helpers.js";
import { activeSessionRegistry, executingTaskLock } from "../active-session-registry.js";
import * as branchAutocorrect from "../branch-autocorrect.js";
import {
  acquireReuseHandoff,
  MergeHandoffRefusedError,
  releaseReuseHandoff,
  resolveIntegrationRemote,
  resolveMergeIntegrationRoot,
} from "../merger-integration-worktree.js";
import * as worktreePool from "../worktree-pool.js";
import { PoolDoubleLeaseError } from "../worktree-pool.js";

describe("resolveMergeIntegrationRoot", () => {
  it("defaults to reusing the task worktree", () => {
    expect(
      resolveMergeIntegrationRoot({
        task: { id: "FN-5279", branch: "fusion/FN-5279", worktree: "/tmp/task-worktree" } as any,
        settings: { mergeIntegrationWorktree: undefined, worktrunk: { enabled: false } } as any,
        projectRoot: "/tmp/project-root",
      }),
    ).toEqual({
      mode: "reuse-task-worktree",
      rootDir: "/tmp/task-worktree",
      branchName: "fusion/fn-5279",
    });
  });

  it("preserves the legacy cwd-main mode when explicitly selected", () => {
    expect(
      resolveMergeIntegrationRoot({
        task: { id: "FN-5279", worktree: "/tmp/task-worktree" } as any,
        settings: { mergeIntegrationWorktree: "cwd-main" as const, worktrunk: { enabled: false } } as any,
        projectRoot: "/tmp/project-root",
      }),
    ).toEqual({
      mode: "cwd-main",
      rootDir: "/tmp/project-root",
      branchName: "fusion/fn-5279",
    });
  });

  it("uses the project root when the task worktree is missing", () => {
    expect(
      resolveMergeIntegrationRoot({
        task: { id: "FN-5279", worktree: undefined } as any,
        settings: { mergeIntegrationWorktree: "reuse-task-worktree", worktrunk: { enabled: false } } as any,
        projectRoot: "/tmp/project-root",
      }),
    ).toEqual({
      mode: "reuse-task-worktree",
      rootDir: "/tmp/project-root",
      branchName: "fusion/fn-5279",
    });
  });

  it("defers to the project root when worktrunk owns merge orchestration", () => {
    expect(
      resolveMergeIntegrationRoot({
        task: { id: "FN-5279", worktree: "/tmp/task-worktree" } as any,
        settings: { mergeIntegrationWorktree: "reuse-task-worktree", worktrunk: { enabled: true } } as any,
        projectRoot: "/tmp/project-root",
      }),
    ).toEqual({
      mode: "cwd-main",
      rootDir: "/tmp/project-root",
      branchName: "fusion/fn-5279",
    });
  });
});

describe("resolveIntegrationRemote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the explicit worktreeRebaseRemote setting", async () => {
    await expect(
      resolveIntegrationRemote({
        settings: { worktreeRebaseRemote: "upstream" } as any,
        rootDir: "/tmp/project-root",
        integrationBranch: "master",
      }),
    ).resolves.toBe("upstream");
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("falls back to the configured branch remote and then repo remotes", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const command = String(cmd);
      if (command.includes("git config --get branch.master.remote")) return Buffer.from("fork\n");
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      resolveIntegrationRemote({
        settings: { worktreeRebaseRemote: "" } as any,
        rootDir: "/tmp/project-root",
        integrationBranch: "master",
      }),
    ).resolves.toBe("fork");
  });
});

describe("acquireReuseHandoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: true });
    vi.spyOn(worktreePool, "getRegisteredWorktreeBranchMap").mockResolvedValue(
      new Map([["fusion/fn-5279", "/tmp/task-worktree"]]),
    );
    vi.spyOn(worktreePool, "canonicalizePath").mockImplementation((value) => value);
    vi.spyOn(branchAutocorrect, "attemptBranchAutocorrect").mockResolvedValue({ status: "renamed" });
    mockedExecSync.mockImplementation((cmd: any) => {
      const command = String(cmd);
      if (command === "git rev-parse --abbrev-ref HEAD") return Buffer.from("fusion/fn-5279\n");
      if (command === "git diff -z --name-only") return Buffer.from("");
      if (command === "git diff -z --cached --name-only") return Buffer.from("");
      if (command === "git status -z --porcelain") return Buffer.from("");
      if (command === "git diff HEAD") return Buffer.from("");
      return Buffer.from("");
    });
  });

  function createStore(taskOverrides: Record<string, unknown> = {}) {
    const store = createMockStore({
      id: "FN-5279",
      branch: "fusion/fn-5279",
      worktree: "/tmp/task-worktree",
      checkedOutBy: undefined,
      checkedOutAt: undefined,
      checkoutLeaseRenewedAt: undefined,
      checkoutNodeId: undefined,
      checkoutRunId: undefined,
      checkoutLeaseEpoch: undefined,
      ...taskOverrides,
    }) as any;
    store.listTasks.mockResolvedValue([
      { id: "FN-5279", column: "in-review", worktree: "/tmp/task-worktree" },
    ]);
    store.acquireMergeQueueLease = vi.fn().mockReturnValue({ taskId: "FN-5279" });
    store.releaseMergeQueueLease = vi.fn();
    return store;
  }

  async function expectRefusal(
    promise: Promise<unknown>,
    gate: string,
    reason: string,
  ): Promise<MergeHandoffRefusedError> {
    await expect(promise).rejects.toBeInstanceOf(MergeHandoffRefusedError);
    try {
      await promise;
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toMatchObject({ gate, reason });
      return error as MergeHandoffRefusedError;
    }
  }

  it("acquires and releases the merge queue lease on the happy path", async () => {
    const store = createStore();
    const auditEmit = vi.fn();

    const handoff = await acquireReuseHandoff({
      task: await store.getTask("FN-5279"),
      store,
      projectRoot: "/tmp/project-root",
      settings: {} as any,
      worktreePath: "/tmp/task-worktree",
      auditEmit,
    });

    expect(handoff).toMatchObject({
      ok: true,
      taskId: "FN-5279",
      worktreePath: "/tmp/task-worktree",
      branch: "fusion/fn-5279",
    });
    expect(store.acquireMergeQueueLease).toHaveBeenCalledWith(
      "merger-reuse-handoff",
      expect.objectContaining({ leaseDurationMs: 900000, targetTaskId: "FN-5279" }),
    );

    await releaseReuseHandoff({ handoff, outcome: "success", auditEmit });
    expect(store.releaseMergeQueueLease).toHaveBeenCalledWith("FN-5279", "merger-reuse-handoff", { kind: "success" });
    expect(auditEmit).toHaveBeenCalledWith({
      type: "merge:reuse-handoff-released",
      target: "/tmp/task-worktree",
      metadata: expect.objectContaining({ taskId: "FN-5279", outcome: "success" }),
    });
  });

  it("refuses dirty reused worktrees with diagnostics", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const command = String(cmd);
      if (command === "git diff -z --name-only") return Buffer.from("packages/engine/src/merger.ts\0");
      if (command === "git diff -z --cached --name-only") return Buffer.from("");
      if (command === "git status -z --porcelain") return Buffer.from("?? stray.txt\0");
      if (command === "git diff HEAD") return Buffer.from("diff --git a/x b/x\n");
      if (command === "git rev-parse --abbrev-ref HEAD") return Buffer.from("fusion/fn-5279\n");
      return Buffer.from("");
    });

    const refusal = await expectRefusal(
      acquireReuseHandoff({
        task: await createStore().getTask("FN-5279"),
        store: createStore(),
        projectRoot: "/tmp/project-root",
        settings: {} as any,
        worktreePath: "/tmp/task-worktree",
      }),
      "working-tree-dirty",
      "dirty-worktree",
    );
    expect(refusal.payload).toMatchObject({
      dirtyPaths: ["packages/engine/src/merger.ts", "stray.txt"],
    });
    expect(refusal.payload.dirtyFingerprint).toEqual(expect.any(String));
  });

  it("attempts FN-5083 case canonicalization before continuing", async () => {
    const store = createStore();
    const auditEmit = vi.fn();
    let reads = 0;
    mockedExecSync.mockImplementation((cmd: any) => {
      const command = String(cmd);
      if (command === "git rev-parse --abbrev-ref HEAD") {
        reads += 1;
        return Buffer.from(reads === 1 ? "fusion/FN-5279\n" : "fusion/fn-5279\n");
      }
      if (command === "git diff -z --name-only") return Buffer.from("");
      if (command === "git diff -z --cached --name-only") return Buffer.from("");
      if (command === "git status -z --porcelain") return Buffer.from("");
      if (command === "git diff HEAD") return Buffer.from("");
      return Buffer.from("");
    });

    await acquireReuseHandoff({
      task: await store.getTask("FN-5279"),
      store,
      projectRoot: "/tmp/project-root",
      settings: {} as any,
      worktreePath: "/tmp/task-worktree",
      auditEmit,
    });

    expect(branchAutocorrect.attemptBranchAutocorrect).toHaveBeenCalledWith({
      worktreePath: "/tmp/task-worktree",
      observedBranch: "fusion/FN-5279",
      expectedBranch: "fusion/fn-5279",
      rootDir: "/tmp/project-root",
    });
    expect(auditEmit).toHaveBeenCalledWith({
      type: "branch:auto-canonicalize-case",
      target: "/tmp/task-worktree",
      metadata: expect.objectContaining({
        taskId: "FN-5279",
        observed: "fusion/FN-5279",
        expected: "fusion/fn-5279",
      }),
    });
  });

  it("refuses wrong-branch heads when canonicalization cannot recover them", async () => {
    vi.spyOn(branchAutocorrect, "attemptBranchAutocorrect").mockResolvedValue({ status: "failed", reason: "nope" });
    mockedExecSync.mockImplementation((cmd: any) => {
      const command = String(cmd);
      if (command === "git rev-parse --abbrev-ref HEAD") return Buffer.from("feature/elsewhere\n");
      if (command === "git diff -z --name-only") return Buffer.from("");
      if (command === "git diff -z --cached --name-only") return Buffer.from("");
      if (command === "git status -z --porcelain") return Buffer.from("");
      if (command === "git diff HEAD") return Buffer.from("");
      return Buffer.from("");
    });

    await expectRefusal(
      acquireReuseHandoff({
        task: await createStore().getTask("FN-5279"),
        store: createStore(),
        projectRoot: "/tmp/project-root",
        settings: {} as any,
        worktreePath: "/tmp/task-worktree",
      }),
      "head-branch-mismatch",
      "unexpected-branch",
    );
  });

  it("reconciles stale same-task activeSessionRegistry entries before proceeding", async () => {
    const store = createStore();
    activeSessionRegistry.registerPath("/tmp/task-worktree", {
      taskId: "FN-5279",
      kind: "executor",
      ownerKey: "FN-5279",
    });
    // FN-5256: backdate so the new min-idle window doesn't refuse the reconcile.
    (activeSessionRegistry.lookupByPath("/tmp/task-worktree") as any).registeredAt = 0;

    await acquireReuseHandoff({
      task: await store.getTask("FN-5279"),
      store,
      projectRoot: "/tmp/project-root",
      settings: {} as any,
      worktreePath: "/tmp/task-worktree",
    });

    expect(activeSessionRegistry.lookupByPath("/tmp/task-worktree")).toBeNull();
  });

  it("refuses live active session bindings", async () => {
    const store = createStore();
    activeSessionRegistry.registerPath("/tmp/task-worktree", {
      taskId: "FN-5279",
      kind: "executor",
      ownerKey: "FN-5279",
    });
    executingTaskLock.tryClaim("FN-5279");

    const refusal = await expectRefusal(
      acquireReuseHandoff({
        task: await store.getTask("FN-5279"),
        store,
        projectRoot: "/tmp/project-root",
        settings: {} as any,
        worktreePath: "/tmp/task-worktree",
      }),
      "active-session-binding",
      "active-session-present",
    );
    expect(refusal.payload).toMatchObject({
      activeRecord: expect.objectContaining({ taskId: "FN-5279" }),
      executingTaskLockHeld: true,
    });
  });

  it("refuses non-canonical branch/worktree mappings", async () => {
    vi.spyOn(worktreePool, "getRegisteredWorktreeBranchMap").mockResolvedValue(new Map([["fusion/fn-5279", "/tmp/elsewhere"]]));
    const store = createStore();

    await expectRefusal(
      acquireReuseHandoff({
        task: await store.getTask("FN-5279"),
        store,
        projectRoot: "/tmp/project-root",
        settings: {} as any,
        worktreePath: "/tmp/task-worktree",
      }),
      "branch-worktree-mapping",
      "registered-branch-mismatch",
    );
  });

  it("refuses live executor leases", async () => {
    const store = createStore({
      checkedOutBy: "agent-1",
      checkedOutAt: new Date().toISOString(),
      checkoutLeaseRenewedAt: new Date().toISOString(),
    });

    await expectRefusal(
      acquireReuseHandoff({
        task: await store.getTask("FN-5279"),
        store,
        projectRoot: "/tmp/project-root",
        settings: {} as any,
        worktreePath: "/tmp/task-worktree",
      }),
      "lease-handoff-failed",
      "executor-lease-active",
    );
  });

  it("refuses central-claim conflicts when surfaced by the store shim", async () => {
    const store = createStore() as any;
    store.projectId = "project-1";
    store.getTaskClaim = vi.fn().mockReturnValue({ ownerAgentId: "agent-2" });

    await expectRefusal(
      acquireReuseHandoff({
        task: await store.getTask("FN-5279"),
        store,
        projectRoot: "/tmp/project-root",
        settings: {} as any,
        worktreePath: "/tmp/task-worktree",
      }),
      "lease-handoff-failed",
      "central-conflict",
    );
  });

  it("surfaces pool double-lease failures with structured diagnostics", async () => {
    const store = createStore();
    store.acquireMergeQueueLease.mockImplementation(() => {
      throw new PoolDoubleLeaseError("/tmp/task-worktree", "FN-1234", "FN-5279", "acquire");
    });

    const refusal = await expectRefusal(
      acquireReuseHandoff({
        task: await store.getTask("FN-5279"),
        store,
        projectRoot: "/tmp/project-root",
        settings: {} as any,
        worktreePath: "/tmp/task-worktree",
      }),
      "lease-handoff-failed",
      "pool-double-lease",
    );
    expect(refusal.payload).toMatchObject({
      existingHolder: "FN-1234",
      path: "/tmp/task-worktree",
      phase: "acquire",
    });
  });

  it("refuses when no merge queue lease can be acquired", async () => {
    const store = createStore();
    store.acquireMergeQueueLease.mockReturnValue(null);

    await expectRefusal(
      acquireReuseHandoff({
        task: await store.getTask("FN-5279"),
        store,
        projectRoot: "/tmp/project-root",
        settings: {} as any,
        worktreePath: "/tmp/task-worktree",
      }),
      "lease-handoff-failed",
      "no-lease",
    );
  });

  // FN-5363 regression: when the merge queue head is polluted with unrelated tasks
  // (e.g. FN-5329, FN-5321, FN-5349), acquiring a lease for a different task (FN-5279)
  // via targetTaskId must succeed — not grab the queue head and then fail with
  // "no-lease" because the returned taskId didn't match.
  it("targets specific task via targetTaskId even when queue head is a different task", async () => {
    const store = createStore();
    // Simulate queue head = different task (polluted queue scenario)
    store.acquireMergeQueueLease = vi.fn().mockReturnValue({ taskId: "FN-5279" });

    const handoff = await acquireReuseHandoff({
      task: await store.getTask("FN-5279"),
      store,
      projectRoot: "/tmp/project-root",
      settings: {} as any,
      worktreePath: "/tmp/task-worktree",
    });

    expect(handoff.taskId).toBe("FN-5279");
    expect(store.acquireMergeQueueLease).toHaveBeenCalledWith(
      "merger-reuse-handoff",
      expect.objectContaining({ targetTaskId: "FN-5279" }),
    );
  });
});

describe("aiMergeTask integration-root behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPathExecSync();
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("detaches the reused task worktree at the integration branch before merging", async () => {
    const store = createMockStore({
      id: "FN-5279",
      worktree: "/tmp/task-worktree",
      branch: "fusion/fn-5279",
      baseBranch: "master",
    }) as any;
    store.getTask.mockResolvedValue({
      ...(await store.getTask("FN-5279")),
      id: "FN-5279",
      worktree: "/tmp/task-worktree",
      branch: "fusion/fn-5279",
      baseBranch: "master",
      checkedOutBy: undefined,
      checkedOutAt: undefined,
      checkoutLeaseRenewedAt: undefined,
      checkoutNodeId: undefined,
      checkoutRunId: undefined,
      checkoutLeaseEpoch: undefined,
    });
    store.getSettings.mockResolvedValue({
      ...await store.getSettings(),
      mergeIntegrationWorktree: "reuse-task-worktree",
      worktreeRebaseBeforeMerge: true,
      worktreeRebaseLocalBase: false,
      worktreeRebaseRemote: "origin",
      baseBranch: "master",
    });
    store.acquireMergeQueueLease = vi.fn().mockReturnValue({ taskId: "FN-5279" });
    store.releaseMergeQueueLease = vi.fn();
    store.listTasks.mockResolvedValue([{ id: "FN-5279", column: "in-review", worktree: "/tmp/task-worktree" }]);

    const baseImpl = mockedExecSync.getMockImplementation();
    mockedExecSync.mockImplementation((cmd: any, opts: any) => {
      const command = String(cmd);
      if (command === "git diff -z --name-only") return Buffer.from("");
      if (command === "git diff -z --cached --name-only") return Buffer.from("");
      if (command === "git status -z --porcelain") return Buffer.from("");
      if (command === "git diff HEAD") return Buffer.from("");
      if (command === "git rev-parse --abbrev-ref HEAD") return Buffer.from("fusion/fn-5279\n");
      if (command === 'git fetch "origin" "master"') return Buffer.from("");
      if (command === 'git fetch "origin"') return Buffer.from("");
      if (command === 'git checkout --detach "master"') return Buffer.from("");
      if (command === 'git rebase "origin/master"') return Buffer.from("");
      if (command === 'git rev-list --left-right --count "origin/master...HEAD"') return Buffer.from("0\t0");
      return baseImpl ? baseImpl(cmd, opts) : Buffer.from("");
    });

    const { aiMergeTask } = await import("../merger.js");
    await aiMergeTask(store, "/tmp/project-root", "FN-5279");

    expect(
      mockedExec.mock.calls.some(([command, opts]) =>
        String(command) === 'git checkout --detach "master"' && (opts as any)?.cwd === "/tmp/task-worktree",
      ),
    ).toBe(true);
    expect(
      mockedExec.mock.calls.some(([command, opts]) =>
        String(command) === 'git fetch "origin" "master"' && (opts as any)?.cwd === "/tmp/task-worktree",
      ),
    ).toBe(true);
  });
});
