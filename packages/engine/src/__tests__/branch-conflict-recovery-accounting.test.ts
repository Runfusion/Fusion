import { describe, expect, it, vi } from "vitest";
import type { AutoRecoverySettings, Task, TaskStore } from "@fusion/core";
import {
  BRANCH_CONFLICT_REFUSAL_HISTORY_WINDOW_MS,
  branchConflictRecoveryCounterPatch,
  branchConflictRecoveryCounterShouldWrite,
  branchConflictRecoveryParkAlreadyApplied,
  branchConflictRefusalHistoryDedupeKey,
  branchConflictRecoveryRemedy,
  branchConflictRecoverySuppressed,
  branchConflictSharedCounterWrite,
  buildBranchConflictRecoveryParkPatch,
  hasBranchConflictRecoveryParkHold,
  planBranchConflictRecoveryPass,
  readBranchConflictRecoveryEpisode,
  recordBranchConflictRefusalHistory,
  BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY,
} from "../recovery/branch-conflict-recovery-accounting.js";

/*
FNXC:BranchConflictRecovery 2026-11-02-22:40 (RUFU-432):
The accounting module is the single authority for the branch-conflict recovery budget, and this is
the seam test for the invariant every consuming site inherits: the counter a card PERSISTS is the
count of counted non-terminal passes, and the pass number a site REPORTS is bounded by the declared
budget. A terminal park is not a counted pass, so it persists nothing.

The budget parameterized over `maxRetries` in {0, 1, 3} and the counter swept well past each budget,
because the two arithmetic errors this module shipped were both edge cases at a budget of 3: a
terminal pass that wrote its own `attempt` back (so the park inflated its own ceiling forever), and a
reported number read straight off that inflated counter (so the operator read "exhausted after 26
bounded passes (budget 3)"). A one-budget assertion would have caught neither shape — the off-by-one
only shows once the counter is past the boundary, and `maxRetries: 0` is the setting where a
single-pass budget has to terminalize on pass 1.

FNXC:BranchConflictRecovery 2026-11-04-14:10 (RUFU-395) — WHAT THESE ASSERTIONS DRIVE ON NOW:
RUFU-432 bounded the counter but left `recoveryRetryCount` as the authority for `terminal` and for the
printed number. That field is the SHARED dispatcher budget, written by planning, the executor and
triage, so a card could be called exhausted for refusals this family never made (measured: shared 10,
zero own refusals, budget 3). Both authorities moved to the family's own register at
`sourceMetadata.branchConflictRecoveryEpisode.refusalCount`.

Three assertions in this file therefore changed subject on purpose, and each is a strengthening:
- A loop test used to hand the planner `{ recoveryRetryCount: n }`. It now applies the counter patch
  each pass and feeds the result back, because the register the park reads is the one the patch writes
  — a test that hand-builds the input could pass while the writer produced something else.
- `toEqual({})` for an inflated shared counter asserted "writes nothing". It now asserts BOTH halves:
  the shared field is neither raised nor lowered, AND the family's own register still advances. The
  old assertion would have accepted a family that never records its own refusals.
- `branchConflictRecoveryParkAlreadyApplied(parked({ recoveryRetryCount: 0 }))` used to assert that a
  zeroed SHARED counter lifts the park. It must now assert the opposite: another lane zeroing its own
  budget does not lift this family's park. The lift is `paused: false`, which is what core's Retry
  patch writes, plus the register null-out.
*/

const COUNTED: AutoRecoverySettings = { mode: "deterministic-only", maxRetries: 3 };
const OFF: AutoRecoverySettings = { mode: "off", maxRetries: 3 };

/** A card carrying this family's terminal park, with the register the park was authored at. */
const parked = (over: Partial<Task> = {}): Task =>
  ({
    id: "RUFU-432",
    paused: true,
    pausedReason: "branch-conflict-recovery-exhausted",
    recoveryRetryCount: 3,
    sourceMetadata: { [BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY]: { refusalCount: 3, firstAt: "2026-11-04T00:00:00.000Z", lastAt: "2026-11-04T00:00:00.000Z", lastSource: "self-owned-reclaim" } },
    ...over,
  }) as unknown as Task;

/** A card whose SHARED counter another layer inflated, with no refusal this family ever recorded. */
const borrowedCounter = (shared: number): Pick<Task, "recoveryRetryCount" | "sourceMetadata"> =>
  ({ recoveryRetryCount: shared, sourceMetadata: {} }) as unknown as Pick<Task, "recoveryRetryCount" | "sourceMetadata">;

/** The row shape the pass planner reads: shared counter plus this family's own register. */
const row = (over: Partial<Task> = {}): Pick<Task, "recoveryRetryCount" | "sourceMetadata"> =>
  ({ recoveryRetryCount: 0, sourceMetadata: {}, ...over }) as unknown as Pick<Task, "recoveryRetryCount" | "sourceMetadata">;

/**
 * Apply one counted pass the way a site does: fold the patch onto the row. Folding through the real
 * patch builder (rather than incrementing by hand) is what keeps the register's authority claim
 * honest — the test drives the writer, not an imitation of it.
 */
function applyCountedPass(current: Pick<Task, "recoveryRetryCount" | "sourceMetadata">, settings: AutoRecoverySettings): Pick<Task, "recoveryRetryCount" | "sourceMetadata"> {
  const pass = planBranchConflictRecoveryPass(current, settings);
  const patch = branchConflictRecoveryCounterPatch(pass, "self-owned-reclaim");
  const merged: Record<string, unknown> = { ...current, ...patch };
  if (patch.sourceMetadataPatch) {
    merged.sourceMetadata = { ...(current.sourceMetadata ?? {}), ...patch.sourceMetadataPatch };
  }
  return merged as unknown as Pick<Task, "recoveryRetryCount" | "sourceMetadata">;
}

describe("planBranchConflictRecoveryPass — counted passes below the budget", () => {
  for (const maxRetries of [0, 1, 3]) {
    it(`persists exactly 1 per counted pass at budget ${maxRetries}, and terminalizes on pass ${maxRetries + 1}`, () => {
      const settings: AutoRecoverySettings = { mode: "deterministic", maxRetries };
      let current = row();
      for (let pass = 1; pass <= maxRetries; pass += 1) {
        const planned = planBranchConflictRecoveryPass(current, settings);
        expect(planned.counted).toBe(true);
        expect(planned.terminal).toBe(false);
        // RUFU-231's shared-counter semantics are unchanged: counted non-terminal passes, +1 each.
        expect(planned.attempt).toBe(pass);
        expect(branchConflictRecoveryCounterShouldWrite(planned)).toBe(true);
        // RUFU-395: the operator-facing number is this family's own, and equals the register it wrote.
        expect(planned.boundedPassCount).toBe(pass);
        current = applyCountedPass(current, settings);
        expect(readBranchConflictRecoveryEpisode(current)?.refusalCount).toBe(pass);
      }
      // The (maxRetries + 1)-th pass is where RUFU-231's boundary terminalizes — and writes nothing.
      const exhausted = planBranchConflictRecoveryPass(current, settings);
      expect(exhausted.terminal).toBe(true);
      expect(exhausted.attempt).toBe(maxRetries + 1);
      expect(branchConflictRecoveryCounterShouldWrite(exhausted)).toBe(false);
      expect(branchConflictRecoveryCounterPatch(exhausted, "self-owned-reclaim")).toEqual({});
    });
  }
});

describe("planBranchConflictRecoveryPass — a saturated register never inflates again", () => {
  for (const maxRetries of [0, 1, 3]) {
    it(`holds at budget ${maxRetries}: every pass past the boundary is terminal, reports a bounded attempt, and writes nothing`, () => {
      const settings: AutoRecoverySettings = { mode: "deterministic", maxRetries };
      // Sweep far past the boundary, including the 26-vs-3 shape that shipped in production. The
      // shared counter is inflated alongside the register so the assertion covers BOTH authorities:
      // neither can push the reported number past the budget.
      for (const persisted of [maxRetries, maxRetries + 1, 12, 26, 19, 60]) {
        const planned = planBranchConflictRecoveryPass(
          row({ recoveryRetryCount: persisted, sourceMetadata: { [BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY]: { refusalCount: persisted, firstAt: "", lastAt: "", lastSource: "self-owned-reclaim" } } }),
          settings,
        );
        expect(planned.terminal).toBe(true);
        expect(planned.attempt).toBeLessThanOrEqual(maxRetries + 1);
        expect(planned.attempt).toBeGreaterThan(maxRetries);
        // RUFU-395: the number the operator reads never exceeds the declared budget. `attempt`
        // clamps at maxRetries + 1; `boundedPassCount` clamps at maxRetries, which is the claim.
        expect(planned.boundedPassCount).toBeLessThanOrEqual(maxRetries);
        expect(branchConflictRecoveryCounterShouldWrite(planned)).toBe(false);
        expect(branchConflictRecoveryCounterPatch(planned, "self-owned-reclaim")).toEqual({});
      }
    });

    it(`never raises a legacy-inflated counter at budget ${maxRetries} and reports it bounded`, () => {
      const settings: AutoRecoverySettings = { mode: "deterministic", maxRetries };
      const inflated = row({ recoveryRetryCount: 26 });
      const pass = planBranchConflictRecoveryPass(inflated, settings);
      const patch = branchConflictRecoveryCounterPatch(pass, "self-owned-reclaim");
      /*
      RUFU-432 asserted `toEqual({})` here — "writes nothing at all". That held while the shared
      field was also the ceiling; under RUFU-395 the family must still record its OWN refusal even
      when the shared field is frozen. The invariant that actually matters is preserved and made
      explicit: the shared value a legacy build inflated to 26 is neither raised nor lowered, so a
      legacy 26 stays 26 rather than climbing.
      */
      expect("recoveryRetryCount" in patch).toBe(false);
      expect(branchConflictSharedCounterWrite(pass)).toBeNull();
      /*
      And the family's own register still records the refusal — except at budget 0, where every pass
      is terminal by definition and a terminal pass is not a counted one, so the register stays absent
      and the patch stays empty. Asserting an advance there would assert a pass the budget forbids.
      */
      if (maxRetries >= 1) {
        expect(readBranchConflictRecoveryEpisode({ sourceMetadata: patch.sourceMetadataPatch as never })?.refusalCount).toBe(1);
        expect(pass.terminal).toBe(false);
      } else {
        expect(patch).toEqual({});
        expect(pass.terminal).toBe(true);
      }
      // The stored shared value is untouched by any pass here, while what a site REPORTS is bounded.
      expect(pass.attempt).toBe(maxRetries + 1);
      expect(pass.boundedPassCount).toBeLessThanOrEqual(Math.max(maxRetries, 0));
    });
  }

  it("leaves the counter alone entirely under mode: off, and never declares terminal", () => {
    const planned = planBranchConflictRecoveryPass(row({ recoveryRetryCount: 26 }), OFF);
    expect(planned.counted).toBe(false);
    expect(planned.terminal).toBe(false);
    expect(branchConflictRecoveryCounterPatch(planned, "self-owned-reclaim")).toEqual({});
  });
});

describe("RUFU-395 — a borrowed shared count can neither park nor be the number in the sentence", () => {
  it("does NOT terminalize on a shared counter another layer inflated, with zero own refusals", () => {
    /*
    The measured live shape: RUFU-378 at shared 32 and RUFU-391 at shared 25 against `maxRetries: 3`,
    with this family's own refusal count at 0. The old authority parked them on the family's FIRST
    refusal — it called a card exhausted for refusals it never made.
    */
    for (const borrowed of [4, 10, 25, 32]) {
      const planned = planBranchConflictRecoveryPass(borrowedCounter(borrowed), { mode: "deterministic", maxRetries: 3 });
      expect(planned.terminal).toBe(false);
      expect(planned.boundedPassCount).toBe(1);
      expect(planned.persisted).toBe(borrowed);
      // The shared field is another layer's decision: this pass neither lowers nor raises it.
      expect(branchConflictSharedCounterWrite(planned)).toBeNull();
    }
  });

  it("terminalizes on this family's OWN (maxRetries + 1)-th refusal regardless of the shared count", () => {
    const settings: AutoRecoverySettings = { mode: "deterministic", maxRetries: 3 };
    let current = row({ recoveryRetryCount: 0 });
    for (let pass = 1; pass <= 3; pass += 1) current = applyCountedPass(current, settings);
    // Another layer now zeroes the shared budget; the family's own exhaustion stands.
    current = { ...current, recoveryRetryCount: 0 };
    const exhausted = planBranchConflictRecoveryPass(current, settings);
    expect(exhausted.terminal).toBe(true);
    expect(exhausted.boundedPassCount).toBe(3);
  });

  it("keeps the park sentence inside the declared budget and equal to the register", () => {
    const settings: AutoRecoverySettings = { mode: "deterministic", maxRetries: 3 };
    let current = row();
    for (let pass = 1; pass <= 3; pass += 1) current = applyCountedPass(current, settings);
    const exhausted = planBranchConflictRecoveryPass(current, settings);
    const sentence = branchConflictRecoveryRemedy(exhausted, "main", "checkout stayed dirty");
    expect(sentence).toContain("after 3 bounded passes (budget 3)");
    expect(sentence).not.toMatch(/after 4 bounded passes/);
    // RUFU-231's operator-facing contract survives the number change: a named door still follows.
    expect(sentence).toMatch(/retry/i);
    expect(sentence).toMatch(/reset it to todo/i);
    expect(sentence).toContain("main");
  });

  it("prints a borrowed-high register-clamped sentence, never the borrowed number", () => {
    const borrowed = borrowedCounter(26);
    const pass = planBranchConflictRecoveryPass(borrowed, { mode: "deterministic", maxRetries: 3 });
    expect(branchConflictRecoveryRemedy(pass, "trunk", "refused")).toContain("after 1 bounded passes (budget 3)");
    expect(branchConflictRecoveryRemedy(pass, "trunk", "refused")).not.toContain("26");
    expect(branchConflictRecoveryRemedy(pass, "trunk", "refused")).toContain("trunk");
  });

  it("advances the shared counter by exactly 1 while it is below its own ceiling", () => {
    // RUFU-231's dispatcher semantics stay: a fresh card still sees 1, 2, 3, 4 and no further.
    const settings: AutoRecoverySettings = { mode: "deterministic", maxRetries: 3 };
    expect(branchConflictSharedCounterWrite(planBranchConflictRecoveryPass(row({ recoveryRetryCount: 0 }), settings))).toBe(1);
    expect(branchConflictSharedCounterWrite(planBranchConflictRecoveryPass(row({ recoveryRetryCount: 2 }), settings))).toBe(3);
    expect(branchConflictSharedCounterWrite(planBranchConflictRecoveryPass(row({ recoveryRetryCount: 3 }), settings))).toBe(4);
    expect(branchConflictSharedCounterWrite(planBranchConflictRecoveryPass(row({ recoveryRetryCount: 4 }), settings))).toBeNull();
  });
});

describe("branchConflictRecoverySuppressed — RUFU-432's release door wins, then the hold", () => {
  it("releases first: a released verdict is never suppressed, park or no park", () => {
    expect(branchConflictRecoverySuppressed({ task: parked(), autoRecovery: COUNTED, released: true })).toBe(false);
    expect(branchConflictRecoverySuppressed({ task: parked(), autoRecovery: COUNTED, released: false })).toBe(true);
  });

  it("suppresses only for this family's own park state", () => {
    const notOurs = parked({ pausedReason: "branch-conflict-unrecoverable" });
    expect(branchConflictRecoverySuppressed({ task: notOurs, autoRecovery: COUNTED, released: false })).toBe(false);
    expect(branchConflictRecoverySuppressed({ task: parked({ paused: false }), autoRecovery: COUNTED, released: false })).toBe(false);
    // An operator pause is not part of the predicate: a card that carries THIS park stays suppressed
    // whether or not it is also operator-paused, because the predicate asks only whose park is on it.
    expect(branchConflictRecoverySuppressed({ task: parked({ userPaused: true }), autoRecovery: COUNTED, released: false })).toBe(true);
    // A borrowed-high shared counter is invisible to the hold: it is not this family's authority.
    expect(hasBranchConflictRecoveryParkHold({ paused: true, pausedReason: "branch-conflict-recovery-exhausted" })).toBe(true);
    expect(hasBranchConflictRecoveryParkHold({ paused: true, pausedReason: "user-requested" })).toBe(false);
  });

  it("leaves the register untouched on a suppressed pass — suppression means zero writes", () => {
    const held = parked();
    const pass = planBranchConflictRecoveryPass(held, COUNTED);
    expect(branchConflictRecoverySuppressed({ task: held, autoRecovery: COUNTED, released: false })).toBe(true);
    // Terminal, so the counter guard refuses; and the park guard refuses above it anyway.
    expect(branchConflictRecoveryCounterShouldWrite(pass)).toBe(false);
    expect(branchConflictRecoveryCounterPatch(pass, "self-owned-reclaim")).toEqual({});
  });
});

describe("buildBranchConflictRecoveryParkPatch — a terminal park persists no counter", () => {
  it("omits recoveryRetryCount while still parking terminal with its remedy", () => {
    const patch = buildBranchConflictRecoveryParkPatch(
      planBranchConflictRecoveryPass(row({ recoveryRetryCount: 3 }), COUNTED),
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

describe("branchConflictRecoveryParkAlreadyApplied — one state, and the operator door lifts it", () => {
  it("holds for exactly the exhausted park state", () => {
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
  });

  /*
  FNXC:BranchConflictRecovery 2026-11-04-14:14 (RUFU-395) — the inversion, stated rather than hidden:
  RUFU-432 asserted that `parked({ recoveryRetryCount: 0 })` reports NOT applied, so that a Retry which
  reached only the counter write still re-armed the recovery. RUFU-395 inverts that on purpose. The
  shared counter is written by planning, the executor and triage; if zeroing it lifted THIS park, a
  lane that refused the card nothing would release a park it never authored — the borrowed-authority
  defect in its release form. The door is `paused: false`, which is exactly what
  `buildAutoPauseClearPatch` writes for this reason (asserted below against core, cross-package).
  */
  it("is NOT lifted by another layer zeroing the shared counter", () => {
    expect(branchConflictRecoveryParkAlreadyApplied(parked({ recoveryRetryCount: 0 }), COUNTED)).toBe(true);
    expect(branchConflictRecoveryParkAlreadyApplied(parked({ recoveryRetryCount: undefined }), COUNTED)).toBe(true);
  });

  it("is lifted by the operator door and by nothing else", () => {
    expect(branchConflictRecoveryParkAlreadyApplied(parked({ paused: false }), COUNTED)).toBe(false);
  });
});

describe("readBranchConflictRecoveryEpisode — a malformed register never parks a card", () => {
  it("reads zero refusals for missing, non-object, and non-numeric shapes", () => {
    for (const raw of [undefined, null, "7", 7, [], {}, { refusalCount: "3" }, { refusalCount: Number.NaN }, { refusalCount: null }]) {
      expect(readBranchConflictRecoveryEpisode({ sourceMetadata: { [BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY]: raw } as never })).toBeNull();
    }
    expect(readBranchConflictRecoveryEpisode({ sourceMetadata: undefined })).toBeNull();
  });

  it("floors and clamps a numeric register rather than trusting it", () => {
    expect(readBranchConflictRecoveryEpisode({ sourceMetadata: { [BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY]: { refusalCount: 2.7, lastSource: "nope" } } } as never)?.refusalCount).toBe(2);
    expect(readBranchConflictRecoveryEpisode({ sourceMetadata: { [BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY]: { refusalCount: -5 } } } as never)?.refusalCount).toBe(0);
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

    FNXC:BranchConflictRecovery 2026-11-04-14:16 (RUFU-395) — the pin widened to the register:
    RUFU-395 made `sourceMetadata.branchConflictRecoveryEpisode.refusalCount` the authority for the
    park, so the cross-package contract is now TWO strings: the pause reason core lifts and the
    register key core nulls out. A Retry that cleared the pause while leaving the register would be a
    no-op — the next refusal would recompute exhaustion from the surviving count and re-park the card
    the operator just released. This asserts the retry patch empties BOTH, and that a retried card can
    then consume the whole budget again before parking.
    */
    const { buildAutoPauseClearPatch, buildManualRetryResetPatch, BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON: coreReason } = await import("@fusion/core");
    expect(coreReason).toBe("branch-conflict-recovery-exhausted");
    const parkedRow = parked() as unknown as Parameters<typeof buildAutoPauseClearPatch>[0];
    const clear = buildAutoPauseClearPatch(parkedRow);
    expect(clear.paused).toBe(false);

    const retried = { ...(parkedRow as object), ...clear, ...buildManualRetryResetPatch() } as unknown as Task;
    expect(retried.paused).toBe(false);
    expect(retried.recoveryRetryCount).toBe(0);
    // The register key is nulled in the SAME patch, under the engine's own exported key constant.
    expect(buildManualRetryResetPatch().sourceMetadataPatch).toMatchObject({
      [BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY]: null,
    });
    // A null-valued key-level patch entry deletes it; model that fold, then prove the card restarts
    // its budget from zero and only re-parks after the full declared number of own refusals.
    const folded = {
      ...retried,
      sourceMetadata: Object.fromEntries(
        Object.entries({ ...(retried.sourceMetadata ?? {}), ...(buildManualRetryResetPatch().sourceMetadataPatch ?? {}) })
          .filter(([, value]) => value !== null),
      ),
    } as unknown as Task;
    expect(readBranchConflictRecoveryEpisode(folded)).toBeNull();
    expect(branchConflictRecoveryParkAlreadyApplied(folded, COUNTED)).toBe(false);

    let current = folded as Pick<Task, "recoveryRetryCount" | "sourceMetadata">;
    for (let pass = 1; pass <= 3; pass += 1) {
      expect(planBranchConflictRecoveryPass(current, COUNTED).terminal).toBe(false);
      current = applyCountedPass(current, COUNTED);
    }
    expect(planBranchConflictRecoveryPass(current, COUNTED).terminal).toBe(true);
  });
});
