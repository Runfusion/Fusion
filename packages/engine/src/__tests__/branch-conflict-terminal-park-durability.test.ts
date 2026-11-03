/*
FNXC:BranchConflictRecovery 2026-11-02-23:00 (RUFU-432):
Terminal branch-conflict parks are durable and bounded.

The RUFU-231 budget was supposed to cap how often a card can be refused; what it actually capped was
how often a card could be refused *before the park started writing its own counter*. The terminal park
patch carried `recoveryRetryCount: pass.attempt`, so every re-admitted pass read its own previous park
value, incremented it and wrote it back: two cards sat at 26 and 19 against a declared budget of 3, and
each climb re-stamped `updated_at` — the row clock the heartbeat reads as recovery liveness — so a dead
card looked alive. Measured: 1 172 task-history rows and 1 038 run-audit rows over 22 days for those
two cards.

This file pins the fixed shape at the executor site (the site with the faithful harness), in four parts:
- the counter stops at its counted value and the REPORTED attempt stays bounded, whatever the stored
  value is, including a legacy-inflated one this pass may never raise;
- a re-encounter of an applied park authors NOTHING — no task-row write, no park audit row, no History
  append, and therefore no `updated_at` re-stamp;
- suppression lives in the write arms, so a parked card is still git-inspected every pass and every
  release door (`stale-resolved`, `tip-already-merged`) still fires;
- refusals did not get looser, only quieter: the same card, same reason, counted passes 1..maxRetries
  still each advance the budget by 1 and still reach the dispatcher.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { BranchConflictError } from "../execution/branch-conflicts.js";
import { handleBranchConflict, type BranchConflictHandleDeps } from "../executor/worktree-branch-conflict-handle.js";

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

const BRANCH = "fusion/rufu-432";
const WORKTREE = "/wt/rufu-432";
const MAX_RETRIES = 2;
const BASE_TS = 1_700_000_000_000;
let writeTicks = 0;

function conflictError(): BranchConflictError {
  return new BranchConflictError({
    branchName: BRANCH,
    conflictingWorktreePath: WORKTREE,
    existingTipSha: "b".repeat(40),
    strandedCommits: [],
    startPoint: "main",
  });
}

function card(recoveryRetryCount?: number): Task {
  return {
    id: "RUFU-432",
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

/** The state the terminal park leaves behind — the input every re-encounter test starts from. */
function parkedCard(): Task {
  return {
    ...card(MAX_RETRIES),
    pausedReason: "branch-conflict-recovery-exhausted",
    error: "Branch-conflict recovery exhausted",
  } as Task;
}

function makeHarness(task: Task, inspection: Record<string, unknown> = { kind: "live-foreign", livePath: WORKTREE, error: conflictError() }) {
  const patches: Array<Partial<Task>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const history: string[] = [];
  // FIDELITY: `updateTask` re-stamps `updatedAt` exactly like the real store, so an assertion that the
  // row clock stayed put can only be satisfied by NOT CALLING the seam. The History seam writes a log
  // row and does not touch the task row.
  const store = {
    getSettings: vi.fn(async () => ({ autoRecovery: { mode: "deterministic-only", maxRetries: MAX_RETRIES } })),
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      patches.push(patch);
      Object.assign(task, patch);
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
  const dispatch = vi.fn(async () => ({ action: "retry" as const }));
  const deps = {
    rootDir: "/repo",
    store: store as unknown as TaskStore,
    getRunContextFor: () => undefined,
    findActiveWorktreeOwner: vi.fn(async () => null),
    normalizeReclaimableWorktreePath: vi.fn(async (_s: string, target: string) => target),
    cleanupConflictingWorktree: vi.fn(async () => false),
    getAutoRecoveryDispatcher: () => ({ dispatch } as never),
    createRunAuditor: () => ({ database: vi.fn(), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() } as never),
    persistTokenUsage: vi.fn(async () => {}),
  } satisfies BranchConflictHandleDeps;
  mocked.inspectBranchConflict.mockResolvedValue(inspection as never);
  return { task, store, patches, auditEvents, history, deps, dispatch };
}

beforeEach(() => {
  vi.clearAllMocks();
  writeTicks = 0;
  mocked.recoverForeignOnlyContamination.mockResolvedValue({ recovered: false });
  mocked.resolveIntegrationBranch.mockResolvedValue("main");
  mocked.mergeEffectiveSettings.mockImplementation(async () => ({ autoRecovery: { mode: "deterministic-only", maxRetries: MAX_RETRIES } }));
  mocked.reportBranchAttribution.mockRejectedValue(new Error("git unreadable in unit seam"));
});

describe("RUFU-432 harness fidelity", () => {
  it("the store double's update seam really does re-stamp updatedAt (otherwise every no-write assertion below is vacuous)", async () => {
    const task = card();
    const { store } = makeHarness(task);
    const before = task.updatedAt;
    await store.updateTask(task.id, { status: "failed" });
    expect(task.updatedAt).not.toBe(before);
    const afterUpdate = task.updatedAt;
    await store.logEntry(task.id, "[recovery] a history line");
    expect(task.updatedAt).toBe(afterUpdate);
  });
});

describe("RUFU-432 a re-encounter of an applied park authors nothing", () => {
  it("writes no task row, no park audit row and no History line, and leaves updatedAt alone", async () => {
    const task = parkedCard();
    const h = makeHarness(task);
    const clockBefore = task.updatedAt;

    await expect(handleBranchConflict(h.deps, task, conflictError())).resolves.toBe("sticky");

    expect(h.store.updateTask).not.toHaveBeenCalled();
    expect(h.auditEvents.filter((e) => e.mutationType === "task:branch-conflict-recovery-parked")).toHaveLength(0);
    expect(h.history.filter((line) => line.includes("parked terminal"))).toHaveLength(0);
    // The three assertions above are the promise; this one is the symptom the operator felt.
    expect(task.updatedAt).toBe(clockBefore);
    // The refusal itself is unchanged in disposition: the card stays parked, not silently released.
    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("branch-conflict-recovery-exhausted");
    expect(task.worktree).toBe(WORKTREE);
    expect(task.branch).toBe(BRANCH);
  });

  it("holds across five further passes: the counter never inflates again and the reported attempt stays bounded", async () => {
    const task = parkedCard();
    const h = makeHarness(task);
    for (let pass = 0; pass < 5; pass += 1) {
      await expect(handleBranchConflict(h.deps, task, conflictError())).resolves.toBe("sticky");
    }
    // The stored budget stays where the last COUNTED pass left it — the shape that shipped was 26 and
    // 19 against a declared budget of 3 because the park kept re-writing its own ceiling.
    expect(task.recoveryRetryCount).toBe(MAX_RETRIES);
    expect(h.store.updateTask).not.toHaveBeenCalled();
    expect(h.auditEvents.filter((e) => e.mutationType === "task:branch-conflict-recovery-parked")).toHaveLength(0);
    // And the number a site would report can never exceed the declared budget by more than one.
    const reported = h.auditEvents.map((e) => (e.metadata as Record<string, unknown> | undefined)?.attempt ?? 0);
    for (const attempt of reported) expect(Number(attempt)).toBeLessThanOrEqual(MAX_RETRIES + 1);
  });

  it("never raises a counter a previous build already inflated, and reports it bounded", async () => {
    const task = { ...parkedCard(), recoveryRetryCount: 26 } as Task;
    const h = makeHarness(task);
    await expect(handleBranchConflict(h.deps, task, conflictError())).resolves.toBe("sticky");
    expect(task.recoveryRetryCount).toBe(26);
    expect(h.store.updateTask).not.toHaveBeenCalled();
    // The remedy sentence reads off the bounded report, not the inflated row: "after 3 bounded
    // passes (budget 2)", never "after 26 bounded passes (budget 2)".
    expect(task.error).not.toMatch(/after 26 bounded passes/);
  });
});

describe("RUFU-432 suppression lives in the write arms, not in front of the git read", () => {
  it("a parked card is still inspected, and its release door still fires", async () => {
    const task = parkedCard();
    // The evidence changed: git now says the stored checkout is stale-admin only.
    const h = makeHarness(task, { kind: "stale-resolved" });
    await expect(handleBranchConflict(h.deps, task, conflictError())).resolves.toBe("retry");
    expect(mocked.inspectBranchConflict).toHaveBeenCalledTimes(1);
    // The release performed its write — a predicate that suppressed before the inspection would have
    // returned here having authored nothing, stranding the card with no way out.
    expect(h.store.updateTask).toHaveBeenCalledTimes(1);
    expect(task.worktree).toBeNull();
    expect(task.branch).toBeNull();
  });

  it("a parked card whose evidence now proves the tip landed still takes the tip-already-merged door", async () => {
    const task = parkedCard();
    const h = makeHarness(task, {
      kind: "tip-already-merged",
      livePath: null,
      tipSha: "c".repeat(40),
      integrationRef: "origin/main",
      landedVia: "local",
      landedStrategy: "squash",
      landedSha: "d".repeat(40),
    });
    const outcome = await handleBranchConflict(h.deps, task, conflictError());
    expect(mocked.inspectBranchConflict).toHaveBeenCalledTimes(1);
    // Whatever the exact disposition, the door must NOT be a silent no-write re-park.
    expect(["retry", "reclaimed", "recovered", "sticky"]).toContain(outcome);
    expect(h.auditEvents.filter((e) => e.mutationType === "task:branch-conflict-recovery-parked")).toHaveLength(0);
  });
});

describe("RUFU-432 refusals get quieter, not looser", () => {
  it("every counted pass still advances the budget by exactly 1 and still reaches the dispatcher", async () => {
    const task = card();
    const h = makeHarness(task);
    for (let pass = 1; pass <= MAX_RETRIES; pass += 1) {
      await expect(handleBranchConflict(h.deps, task, conflictError())).resolves.toBe("retry");
      expect(task.recoveryRetryCount).toBe(pass);
    }
    expect(h.dispatch).toHaveBeenCalledTimes(MAX_RETRIES);
    // The (budget + 1)-th pass is the terminal one, and it is the ONLY pass that authors a park.
    await expect(handleBranchConflict(h.deps, task, conflictError())).resolves.toBe("sticky");
    expect(h.auditEvents.filter((e) => e.mutationType === "task:branch-conflict-recovery-parked")).toHaveLength(1);
    expect(h.history.filter((line) => line.includes("parked terminal"))).toHaveLength(1);
    // An operator Retry zeroes the counter, which alone invalidates the applied-park state: the very
    // next pass is counted again, so the park is revocable rather than permanent.
    task.recoveryRetryCount = 0;
    await expect(handleBranchConflict(h.deps, task, conflictError())).resolves.toBe("retry");
    expect(task.recoveryRetryCount).toBe(1);
  });

  it("a foreign-unmerged collision still refuses with the card's own commits on the branch — the park is not a release", async () => {
    const task = parkedCard();
    const foreignError = new BranchConflictError({
      branchName: BRANCH,
      conflictingWorktreePath: "",
      collisionKind: "foreign-unmerged",
      existingTipSha: "e".repeat(40),
      strandedCommits: [],
      startPoint: "main",
    });
    const h = makeHarness(task, { kind: "live-foreign", livePath: "", error: foreignError });
    await expect(handleBranchConflict(h.deps, task, foreignError)).resolves.toBe("sticky");
    expect(h.store.updateTask).not.toHaveBeenCalled();
    // No release: the branch and its checkout survive the refusal for operator inspection.
    expect(task.branch).toBe(BRANCH);
    expect(task.worktree).toBe(WORKTREE);
  });
});

describe("RUFU-432 F1 pin — no new primitive lets the trailer decide a release", () => {
  /*
  The RUFU-396 discriminator must stay exactly as strict as it shipped: the delivery evidence may name
  a rescue, but a foreign-bound tip stays a REFUSAL decided BEFORE landedness. This is a code-construct
  pin (not a prose pin): it inspects the shared predicate's own signature and call sites, because the
  failure mode R4-F1 warns about is someone threading `deliveryProof` into the misbound decision or
  flipping the rejection-before-landedness order to make a parked card escapable.
  */
  const evidenceSource = readFileSync(resolve(__dirname, "../self-healing-git-evidence.ts"), "utf8");

  it("isBranchTipMisboundToTask takes no delivery-proof argument", () => {
    const decl = evidenceSource.match(/protected async isBranchTipMisboundToTask\(input: \{([\s\S]*?)\}\)/);
    expect(decl, "the misbound predicate's input block must stay findable").not.toBeNull();
    expect(decl![1]).not.toContain("deliveryProof");
    expect(decl![1]).not.toContain("CardScopeDelivery");
    // The keys the shipped predicate accepts, and only those — a new key is a deliberate review event.
    expect(decl![1].match(/\w+\??:/g)?.map((k) => k.replace(/\??:$/, "")).sort()).toEqual(
      ["baseBranch", "branch", "lineageId", "taskId"],
    );
  });

  it("foreignTipRejection is still consulted before landedness inside the misbound predicate", () => {
    // Anchor on the DECLARATION (not the bare name, which also appears in prose above it) and bound
    // the slice at the next method, so the ordering assertion reads the predicate's own body.
    const declAt = evidenceSource.indexOf("protected async isBranchTipMisboundToTask(input:");
    expect(declAt).toBeGreaterThan(-1);
    /*
    Scope to the method's LIVE-TIP path. The earlier `findAlreadyMergedTaskCommit` in this method sits
    in the branch-missing branch, where there is no ref to read a trailer from, so no refusal is even
    expressible there — the RUFU-396 F1 contract is about the live tip: a foreign-bound tip is refused
    BEFORE landedness is computed, so landedness can never argue a foreign card out of its refusal.
    */
    const livePathAt = evidenceSource.indexOf("const branchTip = tipOut.trim();", declAt);
    expect(livePathAt).toBeGreaterThan(declAt);
    const body = evidenceSource.slice(livePathAt, evidenceSource.indexOf("\n  }\n}", livePathAt) > -1 ? evidenceSource.indexOf("\n  }\n}", livePathAt) : livePathAt + 2_000);
    const rejectionAt = body.indexOf("this.foreignTipRejection(");
    const landedAt = body.indexOf("this.findAlreadyMergedTaskCommit(");
    expect(rejectionAt).toBeGreaterThan(-1);
    expect(landedAt).toBeGreaterThan(-1);
    expect(rejectionAt).toBeLessThan(landedAt);
    // The refusal returns before landedness is ever computed — RUFU-396 F1's whole contract.
    expect(body.slice(rejectionAt, landedAt)).toMatch(/if\s*\(\s*rejection\s*\)\s*\{[\s\S]*?return/);
    expect(body).not.toContain("deliveryProof");
  });

  it("the recovery accounting module imports no delivery-proof machinery", () => {
    const accounting = readFileSync(resolve(__dirname, "../recovery/branch-conflict-recovery-accounting.js".replace(/\.js$/, ".ts")), "utf8");
    expect(accounting).not.toMatch(/CardScopeDelivery|resolveBranchBaseDelivery|classifyCardScopeDelivery/);
  });
});
