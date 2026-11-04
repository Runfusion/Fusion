/*
FNXC:BranchConflictRecovery 2026-09-13-00:30:
RUFU-231 (Step 4): the executor-side bounded retry budget for branch-conflict recovery.

RUFU-217's wedge ran forever because every refusal parked or held the card WITHOUT persisting
`recoveryRetryCount` — the dispatcher decision engine's only input — so the budget never
advanced. This suite pins the executor seam (`handleBranchConflict`): each counted pass
persists the counter, the (maxRetries + 1)-th pass parks terminal with the existing
`branch-conflict-recovery-exhausted` reason and an operator-named remedy, and the park never
mutates the retained checkout (terminal park is separated from lease release). It also pins
the seams that make the park reversible (manual-retry counter reset) and schedulable
(the file-scope lease predicate keeps holding only for occupied/unknown, releases on
proven-empty).
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { MANUAL_RETRY_RESET_COUNTER_KEYS, taskHoldsUnmergedCheckout } from "@fusion/core";
import { BranchConflictError } from "../execution/branch-conflicts.js";
import { handleBranchConflict, type BranchConflictHandleDeps } from "../executor/worktree-branch-conflict-handle.js";
import {
  branchConflictRecoveryCounterPatch,
  buildBranchConflictRecoveryParkPatch,
  planBranchConflictRecoveryPass,
} from "../recovery/branch-conflict-recovery-accounting.js";
import { describeTaskWedge } from "../notification/task-wedge-notification.js";

const mocked = vi.hoisted(() => ({
  inspectBranchConflict: vi.fn(),
  reportBranchAttribution: vi.fn(),
  recoverForeignOnlyContamination: vi.fn(),
  resolveIntegrationBranch: vi.fn(),
  mergeEffectiveSettings: vi.fn(),
}));

vi.mock("../execution/branch-conflicts.js", async () => {
  const actual = await vi.importActual<typeof import("../execution/branch-conflicts.js")>(
    "../execution/branch-conflicts.js",
  );
  return {
    ...actual,
    inspectBranchConflict: mocked.inspectBranchConflict,
    reportBranchAttribution: mocked.reportBranchAttribution,
  };
});

vi.mock("../recovery/foreign-only-contamination.js", () => ({
  recoverForeignOnlyContamination: mocked.recoverForeignOnlyContamination,
}));

vi.mock("../merge/integration-branch.js", async () => {
  const actual = await vi.importActual<typeof import("../merge/integration-branch.js")>(
    "../merge/integration-branch.js",
  );
  return { ...actual, resolveIntegrationBranch: mocked.resolveIntegrationBranch };
});

vi.mock("../project/effective-settings.js", () => ({
  mergeEffectiveSettings: mocked.mergeEffectiveSettings,
}));

const BRANCH = "fusion/rufu-231";
const WORKTREE = "/wt/rufu-231";
/** Fixed epoch for the fake's row clock, so stamps are deterministic and strictly increasing. */
const BASE_TS = 1_700_000_000_000;
let writeTicks = 0;

function conflictError(): BranchConflictError {
  return new BranchConflictError({
    branchName: BRANCH,
    conflictingWorktreePath: WORKTREE,
    existingTipSha: "a".repeat(40),
    strandedCommits: [],
    startPoint: "main",
  });
}

function wedgedTask(recoveryRetryCount?: number): Task {
  return {
    id: "FN-R231",
    column: "in-review",
    status: "failed",
    paused: true,
    pausedReason: "branch-conflict-unrecoverable",
    branch: BRANCH,
    worktree: WORKTREE,
    baseBranch: "main",
    recoveryRetryCount,
    updatedAt: new Date(BASE_TS).toISOString(),
  } as Task;
}

/**
 * Store fake that APPLIES patches to the live task object, like the real store does.
 *
 * FNXC:BranchConflictRecovery 2026-11-02-22:45 (RUFU-432) — HARNESS FIDELITY:
 * The real `updateTask` re-stamps `updated_at` on every write, and "a re-encounter of an applied park
 * leaves the row clock alone" is one of the invariants this file now asserts. A double that applied
 * patches without the stamp would make every `updatedAt` assertion here pass vacuously — it would
 * prove the absence of a stamp the fake never performed. So the update seam stamps, and the History
 * seam deliberately does not (it writes a log row, not the task row). The stamping behaviour is
 * itself asserted in `branch-conflict-recovery-harness-fidelity.test.ts`-shape below.
 */
function createStore(task: Task) {
  const patches: Array<Partial<Task>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const history: string[] = [];
  const store = {
    getSettings: vi.fn(async () => ({})),
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task> & { sourceMetadataPatch?: Record<string, unknown> }) => {
      patches.push(patch);
      /*
      FIDELITY (RUFU-395): `sourceMetadataPatch` is the store's KEY-LEVEL channel (RUFU-246) — each
      entry merges into `sourceMetadata`, a null deletes. A flat Object.assign would leave the family's
      own register unwritten, so the executor lane could never reach its own exhaustion and this
      suite's central RUFU-231 assertion would fail for a harness reason rather than a product one.
      */
      const { sourceMetadataPatch, ...rest } = patch;
      Object.assign(task, rest);
      if (sourceMetadataPatch) {
        const merged: Record<string, unknown> = { ...(task.sourceMetadata ?? {}) };
        for (const [key, value] of Object.entries(sourceMetadataPatch)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        task.sourceMetadata = merged as Task["sourceMetadata"];
      }
      // The real store re-stamps the row clock on every write; the fake must too, or a
      // "the row clock stayed put" assertion proves nothing. Monotonic per write so two writes
      // inside one millisecond stay distinguishable.
      writeTicks += 1;
      task.updatedAt = new Date(BASE_TS + writeTicks * 1_000).toISOString();
    }),
    logEntry: vi.fn(async (_id: string, action: string) => {
      history.push(action);
    }),
    appendAgentLog: vi.fn(async () => {}),
    recordRunAuditEvent: vi.fn(async (input: Record<string, unknown>) => {
      auditEvents.push(input);
    }),
  };
  return { store: store as unknown as TaskStore, patches, auditEvents, history };
}

function makeDeps(store: TaskStore, task: Task, dispatch = vi.fn(async (_req: any, _ctx: any) => ({ action: "retry" as const }))) {
  const deps = {
    rootDir: "/repo",
    store,
    getRunContextFor: () => undefined,
    findActiveWorktreeOwner: vi.fn(async () => null),
    normalizeReclaimableWorktreePath: vi.fn(async (_s: string, target: string) => target),
    // Force-cleanup FAILS: the pass must fall through to the budgeted dispatcher block.
    cleanupConflictingWorktree: vi.fn(async () => false),
    getAutoRecoveryDispatcher: () => ({ dispatch } as never),
    createRunAuditor: () => ({ database: vi.fn(), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() } as never),
    persistTokenUsage: vi.fn(async () => {}),
  } satisfies BranchConflictHandleDeps;
  return { deps, dispatch };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.recoverForeignOnlyContamination.mockResolvedValue({ recovered: false });
  mocked.resolveIntegrationBranch.mockResolvedValue("main");
  mocked.mergeEffectiveSettings.mockResolvedValue({ autoRecovery: { mode: "deterministic-only", maxRetries: 2 } });
  mocked.reportBranchAttribution.mockRejectedValue(new Error("git unreadable in unit seam"));
});

describe("RUFU-231 executor branch-conflict retry bound", () => {
  it("advances the persisted counter each pass and parks terminal at maxRetries + 1 with zero checkout mutation", async () => {
    const task = wedgedTask();
    const { store, patches, auditEvents } = createStore(task);
    const { deps, dispatch } = makeDeps(store, task);
    mocked.inspectBranchConflict.mockResolvedValue({ kind: "live-foreign", livePath: WORKTREE, error: conflictError() });

    // Passes 1 and 2 (budget maxRetries=2): counted non-terminal retries.
    await expect(handleBranchConflict(deps, task, conflictError())).resolves.toBe("retry");
    expect(task.recoveryRetryCount).toBe(1);
    await expect(handleBranchConflict(deps, task, conflictError())).resolves.toBe("retry");
    expect(task.recoveryRetryCount).toBe(2);
    expect(dispatch).toHaveBeenCalledTimes(2);

    // Pass 3 = (maxRetries + 1): terminal park instead of another re-offered retry. The
    // non-destructive cleanup attempt still runs (the destructive force-delete only fires when
    // cleanup reports SUCCESS — it never succeeds here); the checkout is never force-deleted.
    await expect(handleBranchConflict(deps, task, conflictError())).resolves.toBe("sticky");
    expect(deps.normalizeReclaimableWorktreePath).not.toHaveBeenCalled();
    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("branch-conflict-recovery-exhausted");
    expect(task.status).toBe("failed");
    /*
    FNXC:BranchConflictRecovery 2026-11-02-22:50 (RUFU-432) — CONTRACT CHANGE from the old assertion:
    This line used to read `expect(task.recoveryRetryCount).toBe(3)`, i.e. it asserted the terminal park
    ADVANCES the counter. That was the bug: the park wrote `recoveryRetryCount: pass.attempt`, so every
    re-admitted pass read its own park value, incremented it and wrote it back — the budget outran its own
    declaration (26 against 3) and each write re-stamped `updated_at`. The new truth: the park persists no
    counter, so the stored value freezes at the last counted pass (2) while the REPORTED attempt (the audit
    row, the remedy sentence) stays `maxRetries + 1`.
    */
    expect(task.recoveryRetryCount).toBe(2);
    // The remedy names the integration branch and at least one recovery door.
    expect(task.error).toContain("main");
    expect(task.error).toMatch(/retry|todo/i);
    // The remedy no longer claims the false suppression it used to promise.
    expect(task.error).not.toMatch(/automatic reclaim passes stay suppressed/);
    // Park is separated from lease release: the patch never touches the retained checkout,
    // and it never touches the budget either.
    const parkPatch = patches.at(-1) as Partial<Task>;
    expect(parkPatch).not.toHaveProperty("worktree");
    expect(parkPatch).not.toHaveProperty("branch");
    expect(parkPatch).not.toHaveProperty("baseCommitSha");
    expect(parkPatch).not.toHaveProperty("recoveryRetryCount");
    expect(task.worktree).toBe(WORKTREE);
    expect(task.branch).toBe(BRANCH);
    // Audit row recorded through the bounded seam with fixed metadata.
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toEqual(expect.objectContaining({
      mutationType: "task:branch-conflict-recovery-parked",
      taskId: "FN-R231",
      metadata: expect.objectContaining({ attempt: 3, maxRetries: 2, source: "executor-conflict", terminal: true }),
    }));
  });

  it("attaches own/foreign attribution evidence when readable and omits it when attribution is unreadable", async () => {
    mocked.inspectBranchConflict.mockResolvedValue({ kind: "live-foreign", livePath: WORKTREE, error: conflictError() });
    const task = wedgedTask();
    const { store } = createStore(task);
    const { deps, dispatch } = makeDeps(store, task);

    mocked.reportBranchAttribution.mockResolvedValue({ ownTrailed: 1, ownUntrailed: ["c"], foreign: ["f1", "f2"], unattributed: [] });
    await handleBranchConflict(deps, task, conflictError());
    expect(dispatch.mock.calls[0][0].evidence).toEqual(expect.objectContaining({
      ownCommits: 2,
      foreignAttributedCommits: 2,
    }));

    // Unreadable attribution keeps the pre-RUFU-231 evidence shape (no own/foreign keys).
    const task2 = wedgedTask();
    const { store: store2 } = createStore(task2);
    const { deps: deps2, dispatch: dispatch2 } = makeDeps(store2, task2);
    mocked.reportBranchAttribution.mockRejectedValueOnce(new Error("git gone"));
    await handleBranchConflict(deps2, task2, conflictError());
    const evidence = dispatch2.mock.calls[0][0].evidence as Record<string, unknown>;
    expect(evidence).not.toHaveProperty("ownCommits");
    expect(evidence).not.toHaveProperty("foreignAttributedCommits");
  });

  it("parks the dispatcher destructive-ambiguity refusal terminal instead of re-offering retry", async () => {
    mocked.inspectBranchConflict.mockResolvedValue({ kind: "live-foreign", livePath: WORKTREE, error: conflictError() });
    const task = wedgedTask();
    const { store, auditEvents } = createStore(task);
    const { deps } = makeDeps(store, task, vi.fn(async (_req: any, _ctx: any) => ({ action: "pause" as const, rationale: "destructive-ambiguity" })));

    await expect(handleBranchConflict(deps, task, conflictError())).resolves.toBe("sticky");
    expect(task.pausedReason).toBe("branch-conflict-recovery-exhausted");
    expect(task.error).toContain("main");
    expect(task.error).toMatch(/retry|todo/i);
    expect(auditEvents[0]).toEqual(expect.objectContaining({
      mutationType: "task:branch-conflict-recovery-parked",
    }));
  });

  it("mode off writes no counter and never parks (operator opt-out keeps refusals pure)", async () => {
    mocked.inspectBranchConflict.mockResolvedValue({ kind: "live-foreign", livePath: WORKTREE, error: conflictError() });
    mocked.mergeEffectiveSettings.mockResolvedValue({ autoRecovery: { mode: "off", maxRetries: 2 } });
    const task = wedgedTask(5);
    const { store, patches } = createStore(task);
    const { deps } = makeDeps(store, task);

    await expect(handleBranchConflict(deps, task, conflictError())).resolves.toBe("retry");
    expect(patches.every((patch) => !("recoveryRetryCount" in patch))).toBe(true);
    expect(task.pausedReason).toBe("branch-conflict-unrecoverable");
    expect(task.recoveryRetryCount).toBe(5);
  });
});

describe("RUFU-231 recovery-budget seams", () => {
  /*
  FNXC:BranchConflictRecovery 2026-11-04-14:32 (RUFU-395):
  The terminal half of this seam assertion moved onto the family's own register. It used to read
  `{ recoveryRetryCount: 2 }` and expect terminal — the SHARED dispatcher budget, which planning,
  the executor and triage also write. The `attempt: 2` / `counted: true` half is unchanged: RUFU-231's
  dispatcher semantics on that field still hold exactly as shipped.
  */
  it("the budget plan is terminal exactly past maxRetries and uncounted only under mode off", () => {
    const settings = { mode: "deterministic-only" as const, maxRetries: 2 };
    const ownRegister = (refusalCount: number) => ({
      recoveryRetryCount: 0,
      sourceMetadata: { branchConflictRecoveryEpisode: { refusalCount, firstAt: "", lastAt: "", lastSource: "executor-conflict" } },
    });
    expect(planBranchConflictRecoveryPass({ recoveryRetryCount: 1, sourceMetadata: {} }, settings)).toMatchObject({ attempt: 2, terminal: false, counted: true });
    // Own refusals spent exactly at the budget: the NEXT pass is the terminal one.
    expect(planBranchConflictRecoveryPass(ownRegister(1), settings).terminal).toBe(false);
    expect(planBranchConflictRecoveryPass(ownRegister(2), settings).terminal).toBe(true);
    // A borrowed shared count alone never decides terminal, however high it is.
    expect(planBranchConflictRecoveryPass({ recoveryRetryCount: 2, sourceMetadata: {} }, settings).terminal).toBe(false);
    expect(planBranchConflictRecoveryPass({ recoveryRetryCount: 40, sourceMetadata: {} }, settings).terminal).toBe(false);
    expect(planBranchConflictRecoveryPass({}, undefined).maxRetries).toBe(3);
    const off = planBranchConflictRecoveryPass({ recoveryRetryCount: 9, sourceMetadata: {} }, { mode: "off", maxRetries: 2 });
    expect(off.counted).toBe(false);
    expect(off.terminal).toBe(false);
    expect(branchConflictRecoveryCounterPatch(off, "executor-conflict")).toEqual({});
  });

  it("the terminal park resolves to a wedge descriptor with an operator action", () => {
    const pass = planBranchConflictRecoveryPass({ recoveryRetryCount: 3 }, { mode: "deterministic-only", maxRetries: 2 });
    const patch = buildBranchConflictRecoveryParkPatch(pass, "main", "branch stayed checked out") as Partial<Task>;
    const parked = { ...wedgedTask(), ...patch } as Task;
    const wedge = describeTaskWedge(parked);
    expect(wedge?.reasonKey).toBe("branch-conflict-recovery-exhausted");
    expect(wedge?.action).toMatch(/retry|todo/i);
  });

  it("manual retry resets the persisted recovery counter (park is reversible by design)", async () => {
    expect(MANUAL_RETRY_RESET_COUNTER_KEYS).toContain("recoveryRetryCount");
  });
});

describe("RUFU-231 lease predicate split (park ≠ lease release)", () => {
  const retained = { worktree: WORKTREE, workspaceWorktrees: undefined } as unknown as Task;

  it("proven-empty releases the retained checkout past done; occupied/unknown/no-proof keep holding", () => {
    expect(taskHoldsUnmergedCheckout(retained, new Map([["", "empty" as const]]))).toBe(false);
    expect(taskHoldsUnmergedCheckout(retained, new Map([["", "occupied" as const]]))).toBe(true);
    expect(taskHoldsUnmergedCheckout(retained, new Map([["", "unknown" as const]]))).toBe(true);
    expect(taskHoldsUnmergedCheckout(retained, undefined)).toBe(true);
    expect(taskHoldsUnmergedCheckout({ worktree: null } as unknown as Task, undefined)).toBe(false);
  });

  it("a workspace card releases only when EVERY retained repo is proven empty", () => {
    const workspaceTask = {
      worktree: null,
      workspaceWorktrees: { entryA: { worktreePath: "/wt/a" }, entryB: { worktreePath: "/wt/b" } },
    } as unknown as Task;
    expect(taskHoldsUnmergedCheckout(workspaceTask, new Map([["entryA", "empty" as const], ["entryB", "occupied" as const]]))).toBe(true);
    expect(taskHoldsUnmergedCheckout(workspaceTask, new Map([["entryA", "empty" as const], ["entryB", "empty" as const]]))).toBe(false);
  });
});
