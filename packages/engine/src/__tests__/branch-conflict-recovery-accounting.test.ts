import { describe, expect, it, vi } from "vitest";
import type { AutoRecoverySettings, Task, TaskStore } from "@fusion/core";
import {
  BRANCH_CONFLICT_REFUSAL_HISTORY_WINDOW_MS,
  branchConflictRecoveryCounterPatch,
  branchConflictRecoveryCounterShouldWrite,
  branchConflictRecoveryParkAlreadyApplied,
  branchConflictRefusalHistoryDedupeKey,
  buildBranchConflictRecoveryParkPatch,
  planBranchConflictRecoveryPass,
  recordBranchConflictRefusalHistory,
} from "../recovery/branch-conflict-recovery-accounting.js";

/*
FNXC:BranchConflictRecovery 2026-11-02-22:40 (RUFU-432):
The accounting module is the single authority for the branch-conflict recovery budget, and this is
the seam test for the invariant every consuming site inherits: the counter a card PERSISTS is the
count of counted non-terminal passes, and the pass number a site REPORTS is
`min(persisted + 1, maxRetries + 1)`. A terminal park is not a counted pass, so it persists nothing.

The budget parameterized over `maxRetries` in {0, 1, 3} and the counter swept well past each budget,
because the two arithmetic errors this module shipped were both edge cases at a budget of 3: a
terminal pass that wrote its own `attempt` back (so the park inflated its own ceiling forever), and a
reported number read straight off that inflated counter (so the operator read "exhausted after 26
bounded passes (budget 3)"). A one-budget assertion would have caught neither shape — the off-by-one
only shows once the counter is past the boundary, and `maxRetries: 0` is the setting where a
single-pass budget has to terminalize on pass 1.
*/

const COUNTED: AutoRecoverySettings = { mode: "deterministic-only", maxRetries: 3 };
const OFF: AutoRecoverySettings = { mode: "off", maxRetries: 3 };

const parked = (over: Partial<Task> = {}): Task =>
  ({
    id: "RUFU-432",
    paused: true,
    pausedReason: "branch-conflict-recovery-exhausted",
    recoveryRetryCount: 3,
    ...over,
  }) as unknown as Task;

describe("planBranchConflictRecoveryPass — counted passes below the budget", () => {
  for (const maxRetries of [0, 1, 3]) {
    it(`persists exactly 1 per counted pass at budget ${maxRetries}, and terminalizes on pass ${maxRetries + 1}`, () => {
      const settings: AutoRecoverySettings = { mode: "deterministic", maxRetries };
      let persisted = 0;
      for (let pass = 1; pass <= maxRetries; pass += 1) {
        const planned = planBranchConflictRecoveryPass({ recoveryRetryCount: persisted }, settings);
        expect(planned.counted).toBe(true);
        expect(planned.terminal).toBe(false);
        expect(planned.attempt).toBe(pass);
        expect(branchConflictRecoveryCounterShouldWrite(planned)).toBe(true);
        expect(branchConflictRecoveryCounterPatch(planned)).toEqual({ recoveryRetryCount: pass });
        persisted = pass;
      }
      // The (maxRetries + 1)-th pass is where RUFU-231's boundary terminalizes — and writes nothing.
      const exhausted = planBranchConflictRecoveryPass({ recoveryRetryCount: persisted }, settings);
      expect(exhausted.terminal).toBe(true);
      expect(exhausted.attempt).toBe(maxRetries + 1);
      expect(branchConflictRecoveryCounterShouldWrite(exhausted)).toBe(false);
      expect(branchConflictRecoveryCounterPatch(exhausted)).toEqual({});
    });
  }
});

describe("planBranchConflictRecoveryPass — a saturated counter never inflates again", () => {
  for (const maxRetries of [0, 1, 3]) {
    it(`holds at budget ${maxRetries}: every pass past the boundary is terminal, reports a bounded attempt, and writes nothing`, () => {
      const settings: AutoRecoverySettings = { mode: "deterministic", maxRetries };
      // Sweep far past the boundary, including the 26-vs-3 shape that shipped in production.
      for (const persisted of [maxRetries, maxRetries + 1, 12, 26, 19, 60]) {
        const planned = planBranchConflictRecoveryPass({ recoveryRetryCount: persisted }, settings);
        expect(planned.terminal).toBe(true);
        expect(planned.attempt).toBeLessThanOrEqual(maxRetries + 1);
        expect(planned.attempt).toBeGreaterThan(maxRetries);
        expect(branchConflictRecoveryCounterShouldWrite(planned)).toBe(false);
        expect(branchConflictRecoveryCounterPatch(planned)).toEqual({});
      }
    });

    it(`never raises a legacy-inflated counter at budget ${maxRetries} and reports it bounded`, () => {
      const settings: AutoRecoverySettings = { mode: "deterministic", maxRetries };
      const inflated = { recoveryRetryCount: 26 };
      expect(branchConflictRecoveryCounterPatch(planBranchConflictRecoveryPass(inflated, settings))).toEqual({});
      // The stored value is untouched by any pass here, so a legacy 26 stays 26 rather than
      // climbing; what is bounded is the number a site reports about it.
      expect(planBranchConflictRecoveryPass(inflated, settings).attempt).toBe(maxRetries + 1);
    });
  }

  it("leaves the counter alone entirely under mode: off, and never declares terminal", () => {
    const planned = planBranchConflictRecoveryPass({ recoveryRetryCount: 26 }, OFF);
    expect(planned.counted).toBe(false);
    expect(planned.terminal).toBe(false);
    expect(branchConflictRecoveryCounterPatch(planned)).toEqual({});
  });
});

describe("buildBranchConflictRecoveryParkPatch — a terminal park persists no counter", () => {
  it("omits recoveryRetryCount while still parking terminal with its remedy", () => {
    const patch = buildBranchConflictRecoveryParkPatch(
      planBranchConflictRecoveryPass({ recoveryRetryCount: 3 }, COUNTED),
      "main",
      "branch is merged but the checkout is dirty",
    );
    expect("recoveryRetryCount" in patch).toBe(false);
    expect(patch.status).toBe("failed");
    expect(patch.paused).toBe(true);
    expect(patch.pausedReason).toBe("branch-conflict-recovery-exhausted");
    expect(patch.error).toContain("retry");
    // The checkout the operator must inspect is never mutated by a park.
    expect(patch.worktree).toBeUndefined();
    expect(patch.branch).toBeUndefined();
    expect(patch.baseCommitSha).toBeUndefined();
  });
});

describe("branchConflictRecoveryParkAlreadyApplied — one state, and the counter write lifts it", () => {
  it("holds for exactly the exhausted park with a spent budget", () => {
    expect(branchConflictRecoveryParkAlreadyApplied(parked(), COUNTED)).toBe(true);
  });

  it("does not hold for any other state", () => {
    expect(branchConflictRecoveryParkAlreadyApplied(parked({ paused: false }), COUNTED)).toBe(false);
    expect(branchConflictRecoveryParkAlreadyApplied(parked({ paused: undefined }), COUNTED)).toBe(false);
    expect(branchConflictRecoveryParkAlreadyApplied(parked({ pausedReason: "branch-conflict-unrecoverable" }), COUNTED)).toBe(false);
    expect(branchConflictRecoveryParkAlreadyApplied(parked({ pausedReason: null }), COUNTED)).toBe(false);
    expect(branchConflictRecoveryParkAlreadyApplied(parked({ pausedReason: "in-review-stall-deadlock" }), COUNTED)).toBe(false);
    expect(branchConflictRecoveryParkAlreadyApplied(parked({ pausedReason: "user-requested" }), COUNTED)).toBe(false);
    // A transient pause that a re-encounter legitimately re-writes.
    expect(branchConflictRecoveryParkAlreadyApplied({ paused: true, pausedReason: "branch-conflict-unrecoverable", recoveryRetryCount: 0 }, COUNTED)).toBe(false);
    // The operator door: the counter zero alone invalidates the park, before any pause write.
    expect(branchConflictRecoveryParkAlreadyApplied(parked({ recoveryRetryCount: 0 }), COUNTED)).toBe(false);
    expect(branchConflictRecoveryParkAlreadyApplied(parked({ recoveryRetryCount: undefined }), COUNTED)).toBe(false);
  });
});

describe("recordBranchConflictRefusalHistory — the three seam cases", () => {
  it("appends once per window through the deduped seam, and nothing on a repeat inside the window", async () => {
    const logEntryOnce = vi.fn(async () => true);
    const logEntry = vi.fn(async () => {});
    const store = { logEntryOnce, logEntry } as unknown as TaskStore;
    const dedupeKey = branchConflictRefusalHistoryDedupeKey({ taskId: "RUFU-432", reason: "tip-already-merged", candidateSha: "031e6b46b1182af2f5466fec" });
    const message = "[recovery] RUFU-432 already-merged rejected: foreign unmerged commits";

    expect(await recordBranchConflictRefusalHistory(store, { taskId: "RUFU-432", message, dedupeKey, parkApplied: false })).toBe("windowed");
    logEntryOnce.mockResolvedValueOnce(false);
    expect(await recordBranchConflictRefusalHistory(store, { taskId: "RUFU-432", message, dedupeKey, parkApplied: false })).toBe("suppressed");

    expect(logEntryOnce).toHaveBeenCalledTimes(2);
    expect(logEntryOnce.mock.calls[0]?.[1]).toMatchObject({ action: message, dedupeKey, windowMs: BRANCH_CONFLICT_REFUSAL_HISTORY_WINDOW_MS });
    // The windowed seam is the only append path when it exists — no parallel plain-logEntry lane.
    expect(logEntry).not.toHaveBeenCalled();
    // Identity is stable per (card, reason, tip): the same refusal re-announces under the same key.
    expect(branchConflictRefusalHistoryDedupeKey({ taskId: "RUFU-432", reason: "tip-already-merged", candidateSha: "031e6b46b1182af2f5466fec" })).toBe(dedupeKey);
    expect(branchConflictRefusalHistoryDedupeKey({ taskId: "RUFU-432", reason: "tip-already-merged", candidateSha: "aaaaaaaaaaaa1af2f5466fec" })).not.toBe(dedupeKey);
  });

  it("appends NOTHING for a re-encounter of an applied park when the deduped seam is absent", async () => {
    const logEntry = vi.fn(async () => {});
    const store = { logEntry } as unknown as TaskStore;
    expect(await recordBranchConflictRefusalHistory(store, {
      taskId: "RUFU-432",
      message: "[recovery] refusal",
      dedupeKey: "branch-conflict-refusal:RUFU-432:tip-already-merged:031e6b46b118",
      parkApplied: true,
    })).toBe("suppressed-park");
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("appends exactly once through the plain seam for a live card when the deduped seam is absent", async () => {
    const logEntry = vi.fn(async () => {});
    const store = { logEntry } as unknown as TaskStore;
    expect(await recordBranchConflictRefusalHistory(store, {
      taskId: "RUFU-432",
      message: "[recovery] refusal",
      dedupeKey: "branch-conflict-refusal:RUFU-432:tip-already-merged:031e6b46b118",
      parkApplied: false,
    })).toBe("fallback");
    expect(logEntry).toHaveBeenCalledTimes(1);
    expect(logEntry).toHaveBeenCalledWith("RUFU-432", "[recovery] refusal");
  });

  it("swallows a throwing seam into a debug line instead of failing the refusal", async () => {
    const store = {
      logEntryOnce: vi.fn(async () => {
        throw new Error("history write failed");
      }),
      logEntry: vi.fn(async () => {}),
    } as unknown as TaskStore;
    await expect(recordBranchConflictRefusalHistory(store, {
      taskId: "RUFU-432",
      message: "[recovery] refusal",
      dedupeKey: "branch-conflict-refusal:RUFU-432:tip-already-merged:031e6b46b118",
      parkApplied: false,
    })).resolves.toBe("failed");
    // A refusal whose History write exploded still ran its seam; it never fell through into a
    // second plain-append attempt that would double the row the failing seam may already have written.
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("is invalidated by the operator Retry patch, in the one seam every Retry surface shares", async () => {
    /*
    FNXC:BranchConflictRecovery 2026-11-02-23:21 (RUFU-432) — the CROSS-PACKAGE pin:
    The engine's suppression and core's Retry lift are in different packages, so the contract between
    them is exactly one string. If either side renames the reason, the park stops being liftable and
    nothing else in the toolchain notices — lint, typecheck and build all stay green. This asserts the
    pair against each other rather than against two literals.
    */
    const { buildAutoPauseClearPatch, buildManualRetryResetPatch, BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON: coreReason } = await import("@fusion/core");
    expect(coreReason).toBe("branch-conflict-recovery-exhausted");
    const parkedRow = parked({ recoveryRetryCount: 3 }) as unknown as Parameters<typeof buildAutoPauseClearPatch>[0];
    const clear = buildAutoPauseClearPatch(parkedRow);
    expect(clear.paused).toBe(false);

    const retried = { ...(parkedRow as object), ...clear, ...buildManualRetryResetPatch() } as unknown as Task;
    expect(retried.paused).toBe(false);
    expect(retried.recoveryRetryCount).toBe(0);
    // Either half alone is enough to invalidate the applied-park state, which is why a Retry that
    // reached only one of them still re-arms the recovery.
    expect(branchConflictRecoveryParkAlreadyApplied(retried, COUNTED)).toBe(false);
    expect(branchConflictRecoveryParkAlreadyApplied({ ...retried, paused: true }, COUNTED)).toBe(false);
  });
});
