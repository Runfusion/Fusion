/*
FNXC:BranchConflictRecovery 2026-09-12-23:30:
RUFU-231 regression suite for the zero-own-commit / foreign-tainted-base recovery loop.

Shape (from the RUFU-217 operator wedge): a review-lane card, failed + paused with
`pausedReason: "branch-conflict-unrecoverable"`, whose task branch owns ZERO commits and
whose tip belongs to another lineage. The reclaim sweep re-admits that pausedReason every
maintenance pass; when no automatic exit can prove the shape zero-loss, every pass repeats
the same pair of refusals forever and the card's retained checkout keeps a peer's
`overlapBlockedBy` pointing at it.

The verified causes this suite pins (recorded in the RUFU-231 task log; the operator's
`foreign-tainted` literal is a deployed-bundle artifact — HEAD emits
foreign-task-tip/foreign-lineage-tip/foreign-landed-commit/ownership-unverifiable/ambiguous):
  (b) the sweep's branch-conflict pause happens, and
  (c) `recoveryRetryCount` is never written, so the dispatcher's retry budget can never
      advance and the card is re-admitted indefinitely.
After the fix the same fixtures assert: the persisted counter advances per attempt, the
(maxRetries + 1)-th dispatch parks terminal with `branch-conflict-recovery-exhausted` and a
named remedy, the refusal log pair never repeats, and the parked card is no longer a sweep
candidate while its checkout stays byte-identical (termination + remedy, NOT an unblock).
*/
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";
import { BranchConflictError } from "../execution/branch-conflicts.js";
import { withBranchWriteProvenance } from "./branch-write-provenance-store-stub.js";
import { RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";

vi.mock("../worktree/worktree-pool.js", () => ({
  isUsableTaskWorktree: vi.fn().mockResolvedValue(true),
  classifyTaskWorktree: vi.fn().mockResolvedValue({ ok: false, classification: "missing", reason: "test" }),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  relocateReclaimableWorktreeIntoRoot: vi.fn(async ({ sourcePath }: { sourcePath: string }) => ({
    kind: "ready" as const,
    path: sourcePath,
    relocated: false,
  })),
  getRegisteredWorktreePaths: vi.fn().mockReturnValue([]),
  getRegisteredWorktreeBranchMap: vi.fn().mockReturnValue(new Map()),
  resolveWorktreeBackend: vi.fn().mockReturnValue({ kind: "native" }),
  scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  scanOrphanedBranches: vi.fn().mockResolvedValue([]),
}));

const mocked = vi.hoisted(() => ({
  inspectBranchConflict: vi.fn(),
  recoverForeignOnlyContamination: vi.fn(),
}));

vi.mock("../execution/branch-conflicts.js", async () => {
  const actual = await vi.importActual<typeof import("../execution/branch-conflicts.js")>(
    "../execution/branch-conflicts.js",
  );
  return {
    ...actual,
    inspectBranchConflict: mocked.inspectBranchConflict,
  };
});

vi.mock("../recovery/foreign-only-contamination.js", async () => {
  const actual = await vi.importActual<typeof import("../recovery/foreign-only-contamination.js")>(
    "../recovery/foreign-only-contamination.js",
  );
  return {
    ...actual,
    recoverForeignOnlyContamination: mocked.recoverForeignOnlyContamination,
  };
});

import { SelfHealingManager } from "../self-healing.js";

const NOW = "2026-09-12T20:20:53.000Z";

function wedgedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-231W",
    title: "FN-231W",
    description: "zero-own-commit foreign-base card",
    column: "in-review",
    status: "failed",
    paused: true,
    pausedReason: "branch-conflict-unrecoverable",
    userPaused: false,
    branch: "fusion/fn-231w",
    branchWriteOrigin: "engine",
    worktree: "/tmp/fusion-rufu231/fn-231w",
    dependencies: [],
    steps: [],
    log: [],
    createdAt: NOW,
    updatedAt: NOW,
    // baseBranch / executionStartBranch / baseCommitSha deliberately ABSENT — the wedge
    // recorded no base identity (Mission defect 1).
    ...overrides,
  } as Task;
}

function liveForeignThrow(task: Task): never {
  throw new BranchConflictError({
    branchName: task.branch!,
    conflictingWorktreePath: task.worktree!,
    existingTipSha: "a5de0711d6ae0000000000000000000000000000",
    strandedCommits: [{ sha: "a5de0711d6ae0000000000000000000000000000", subject: "feat(FN-355): foreign landed work" }],
    startPoint: "main",
    recommendedAction: "Inspect/reclaim or discard the conflicting local branch/worktree with git tooling before retrying.",
  });
}

function createStore(initialTasks: Task[], settings: Partial<Settings> = {}) {
  const tasks = new Map(initialTasks.map((task) => [task.id, { ...task }]));
  const mergedSettings = {
    globalPause: false,
    enginePaused: false,
    autoMerge: true,
    maintenanceIntervalMs: 0,
    autoRecovery: { mode: "deterministic-only" as const, maxRetries: 3 },
    ...settings,
  } as Settings;

  /*
  FIDELITY (RUFU-395): the store applies `sourceMetadataPatch` at KEY level with null-as-delete
  (RUFU-246), and the branch-conflict family now carries its refusal register on that channel.
  A flat spread would park the register on a bogus top-level key, so the sweep's own exhaustion could
  never be reached and this file's central RUFU-231 assertion would fail for a harness reason.
  */
  const applyPatch = (current: Task, patch: Record<string, unknown>): Task => {
    const { sourceMetadataPatch, ...rest } = patch as { sourceMetadataPatch?: Record<string, unknown> };
    const next = { ...current, ...rest } as Task;
    if (sourceMetadataPatch) {
      const merged: Record<string, unknown> = { ...(current.sourceMetadata ?? {}) };
      for (const [key, value] of Object.entries(sourceMetadataPatch)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      next.sourceMetadata = merged as Task["sourceMetadata"];
    }
    return next;
  };

  const updateTask = vi.fn(withBranchWriteProvenance(async (id: string, patch: Partial<Task>) => {
    const current = tasks.get(id);
    if (!current) throw new Error(`Task ${id} missing`);
    const next = applyPatch(current, patch as Record<string, unknown>);
    tasks.set(id, next);
    return next;
  }));
  /*
  FIDELITY: the self-owned reclaim persists its pause through `updateTaskAtomic` under the task
  advisory lock. A store without the seam made the whole sweep throw (`is not a function`) and every
  assertion in this file failed on an empty sweep — a harness gap that had been silently hiding the
  sweep's behavior, not a product defect.
  */
  const updateTaskAtomic = vi.fn(async (id: string, mutate: (live: Task) => Record<string, unknown> | null) => {
    const current = tasks.get(id);
    if (!current) throw new Error(`Task ${id} missing`);
    const patch = mutate(current);
    if (patch === null) return null;
    const next = applyPatch(current, patch);
    tasks.set(id, next);
    return next;
  });
  const moveTask = vi.fn(async (id: string, column: Task["column"]) => {
    const current = tasks.get(id);
    if (!current) throw new Error(`Task ${id} missing`);
    const next = { ...current, column } as Task;
    tasks.set(id, next);
    return next;
  });
  const logEntry = vi.fn(async () => undefined);

  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => mergedSettings),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => {
      const values = [...tasks.values()].filter((task) => !task.deletedAt);
      return column ? values.filter((task) => task.column === column) : values;
    }),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    updateTask,
    updateTaskAtomic,
    moveTask,
    logEntry,
    handoffToReview: vi.fn(async (id: string) => tasks.get(id)!),
    recordAgentActivity: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
  }) as unknown as TaskStore & EventEmitter;

  return { mergedSettings, store, tasks, updateTask, updateTaskAtomic, moveTask, logEntry };
}

function managerFor(store: TaskStore & EventEmitter) {
  const manager = new SelfHealingManager(store, { rootDir: "/tmp/fusion-rufu231", getExecutingTaskIds: () => new Set<string>() });
  vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: true, stalenessMs: 0, reason: "test", metadata: {} });
  return manager;
}

function refusalLines(logEntry: ReturnType<typeof vi.fn>): string[] {
  return logEntry.mock.calls
    .map((call) => String(call[1] ?? ""))
    .filter((message) => message.includes("already-merged rejected") || message.includes("is already checked out at"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.recoverForeignOnlyContamination.mockResolvedValue({ recovered: false, reason: "ambiguous" });
});

describe("RUFU-231 zero-own-commit / foreign-base recovery loop (sweep)", () => {
  it("persists recoveryRetryCount on every branch-conflict pause so the retry budget advances", async () => {
    const task = wedgedTask();
    const { store, tasks, updateTaskAtomic } = createStore([task]);
    const manager = managerFor(store);
    mocked.inspectBranchConflict.mockImplementation(() => liveForeignThrow(task));

    await manager.reclaimSelfOwnedBranchConflicts();

    // Pre-fix this fails: the pause writes `pausedReason: branch-conflict-unrecoverable`
    // but never the counter, so the dispatcher budget can never reach exhaustion.
    /*
    FIDELITY (RUFU-395): the pause travels through `updateTaskAtomic`, the same seam the reclaim
    persists under the task advisory lock. The assertion followed the write to the seam the product
    actually uses; the load-bearing claim is unchanged and is checked twice — on the patch AND on the
    row that ends up in the store — because a patch that never lands is the failure mode here.
    */
    expect(updateTaskAtomic).toHaveBeenCalledWith(
      task.id,
      expect.any(Function),
    );
    expect(tasks.get(task.id)?.recoveryRetryCount).toBe(1);
    expect(tasks.get(task.id)).toMatchObject({ paused: true, status: "failed" });
    /*
    RUFU-395: the same pause must also record this family's OWN refusal, because that register — not
    the shared field — is what decides exhaustion. Without this, a lane that zeroed the shared counter
    could silently stop the family from ever counting toward its park.
    */
    expect((tasks.get(task.id)?.sourceMetadata as Record<string, { refusalCount: number }> | undefined)?.branchConflictRecoveryEpisode?.refusalCount).toBe(1);
  });

  it("each sweep advances the counter and the (maxRetries + 1)-th dispatch parks terminal with a named remedy and zero checkout mutation", async () => {
    const task = wedgedTask();
    const { store, tasks, logEntry, updateTask } = createStore([task]);
    const manager = managerFor(store);
    mocked.inspectBranchConflict.mockImplementation(() => liveForeignThrow(task));

    const parks: Array<Task | undefined> = [];
    for (let pass = 0; pass < 4; pass += 1) {
      await manager.reclaimSelfOwnedBranchConflicts();
      parks.push(tasks.get(task.id));
    }

    // Passes 1..3 keep the recoverable pause while the budget advances.
    expect(parks[0]?.recoveryRetryCount).toBe(1);
    expect(parks[1]?.recoveryRetryCount).toBe(2);
    expect(parks[2]?.recoveryRetryCount).toBe(3);
    expect(parks[2]?.pausedReason).toBe("branch-conflict-unrecoverable");

    // Pass 4 (maxRetries + 1) must terminate instead of re-parking the same transient pause.
    const parked = parks[3]!;
    expect(parked.pausedReason).toBe("branch-conflict-recovery-exhausted");
    expect(parked.paused).toBe(true);
    expect(parked.status).toBe("failed");
    expect(String(parked.error)).toMatch(/main/i);
    expect(String(parked.error).toLowerCase()).toMatch(/todo|reset|retry/);

    // Terminal park performs ZERO git mutation: checkout identity stays byte-identical.
    expect(parked.worktree).toBe("/tmp/fusion-rufu231/fn-231w");
    expect(parked.branch).toBe("fusion/fn-231w");

    // A fifth sweep performs zero actions on the card (the review bucket no longer re-admits).
    const logCallsBefore = logEntry.mock.calls.length;
    const updateCallsBefore = updateTask.mock.calls.length;
    const recovered = await manager.reclaimSelfOwnedBranchConflicts();
    expect(recovered).toBe(0);
    expect(logEntry.mock.calls.length).toBe(logCallsBefore);
    expect(updateTask.mock.calls.length).toBe(updateCallsBefore);
  });

  it("the proven-zero-loss shape exits through recovery instead of re-pausing, and never repeats the refusal pair", async () => {
    const task = wedgedTask();
    const { store, updateTask, logEntry } = createStore([task]);
    const manager = managerFor(store);
    mocked.inspectBranchConflict.mockImplementation(() => liveForeignThrow(task));
    mocked.recoverForeignOnlyContamination.mockResolvedValue({ recovered: true, subtype: "branch-discard" });

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    // A recovered card must NOT take the unrecoverable-pause write (the real recovery
    // function owns the paused/error clears; the sweep contributes nothing beyond it).
    const pauseWrites = updateTask.mock.calls.filter(
      (call) => (call[1] as Partial<Task>)?.paused === true || (call[1] as Partial<Task>)?.pausedReason !== undefined,
    );
    expect(pauseWrites).toEqual([]);
    expect(refusalLines(logEntry)).toEqual([]);
  });

  it("never logs the wedged refusal pair when recovery engages", async () => {
    const task = wedgedTask();
    const { store, logEntry } = createStore([task]);
    const manager = managerFor(store);
    mocked.inspectBranchConflict.mockImplementation(() => liveForeignThrow(task));
    mocked.recoverForeignOnlyContamination.mockResolvedValue({ recovered: true, subtype: "reanchor" });

    await manager.reclaimSelfOwnedBranchConflicts();

    expect(refusalLines(logEntry)).toEqual([]);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-09-13-01:10 (RUFU-231 Step 5, renamed-board parity):
The historical blind-spot class: recovery sweeps whose reads or guards key on legacy column
literals go silent on a board that renamed its lanes. RUFU-231's counter advance and terminal
park are lifecycle decisions every board needs — this test proves they fire on a board where
the review lane is `checking` and no legacy literal exists, by seeding the store with ONLY the
renamed vocabulary (no `in-review` row anywhere).
*/
describe("RUFU-231 recovery exits on a renamed board (parity)", () => {
  it("counter advances and the (maxRetries + 1)-th pass parks terminal with renamed lane ids", async () => {
    const renamedIr = lifecycleIr(RENAMED_VOCAB, "rufu231-renamed") as WorkflowIr;
    const task = wedgedTask({ column: RENAMED_VOCAB.review as Task["column"] });
    const { store, tasks } = createStore([task], { autoRecovery: { mode: "deterministic-only", maxRetries: 1 } } as Partial<Settings>);
    Object.assign(store, {
      listWorkflowDefinitions: vi.fn(async () => [{ ir: renamedIr }]),
      getTaskWorkflowSelection: () => ({ workflowId: "rufu231-renamed", stepIds: [] }),
      getTaskWorkflowSelectionAsync: async () => ({ workflowId: "rufu231-renamed", stepIds: [] }),
      getWorkflowDefinition: async (id: string) => (id === "rufu231-renamed" ? { ir: renamedIr } : undefined),
    });
    const manager = managerFor(store);
    mocked.inspectBranchConflict.mockImplementation(() => liveForeignThrow(task));

    // Pass 1 (attempt 1 ≤ maxRetries): the recoverable pause, counter persisted, on `checking`.
    await manager.reclaimSelfOwnedBranchConflicts();
    expect(tasks.get(task.id)?.recoveryRetryCount).toBe(1);
    expect(tasks.get(task.id)?.pausedReason).toBe("branch-conflict-unrecoverable");
    expect(tasks.get(task.id)?.column).toBe(RENAMED_VOCAB.review);

    // Pass 2 (attempt 2 > maxRetries): terminal park fires on the renamed board too.
    await manager.reclaimSelfOwnedBranchConflicts();
    const parked = tasks.get(task.id)!;
    expect(parked.pausedReason).toBe("branch-conflict-recovery-exhausted");
    expect(parked.paused).toBe(true);
    expect(parked.status).toBe("failed");
    expect(parked.worktree).toBe("/tmp/fusion-rufu231/fn-231w");
    expect(parked.branch).toBe("fusion/fn-231w");

    // The exhausted park is not re-admitted by the review bucket on a renamed board either:
    // a third sweep leaves the row byte-identical (no counter creep, no re-pause, no release).
    const parkedSnapshot = { ...tasks.get(task.id)! };
    await manager.reclaimSelfOwnedBranchConflicts();
    expect(tasks.get(task.id)).toEqual(parkedSnapshot);
  });
});
