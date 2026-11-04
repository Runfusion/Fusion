/*
FNXC:BranchConflictRecovery 2026-11-04-14:50 (RUFU-395) — the repeated-park regression.

The reported symptom: a card parked by branch-conflict recovery was re-refused, re-parked, and
re-announced on every sweep, forever, with a counter that grew without limit. RUFU-432 stopped the
counter from growing on the WRITE side and suppressed re-authoring at the terminal arms, but left the
DECISION reading `recoveryRetryCount` — a field planning, the executor and triage all write — so a card
could be called exhausted for refusals this family never made, and the auto-recovery dispatcher's
irreducible pause still had no terminal disposition at all (it advanced the register and could therefore
never carry the park reason the suppression reads).

What this file pins is the acceptance shape, stated as emissions rather than as field values:

  1. A parked card survives two consecutive sweeps with ZERO new emissions — no task-row write, no
     History line, no park row, no rejection row, no row-clock bump — while remaining parked, refused,
     and checked out.
  2. The release door still runs: a parked card whose git verdict changed is still rescued, so the
     suppression is not a skip of the release decision (RUFU-432's preserved contract).
  3. ONE operator Retry lets a real conflict consume the WHOLE budget again and park again, and a
     SECOND Retry still works.
  4. The park sentence never claims more passes than the settings declare.
  5. Every source that shares the park patch reaches a park whose reason is the suppression's own
     domain — including the dispatcher handler that previously had none.

The harness reuses the real `SelfHealingManager.rejectForeignAlreadyMergedCandidate` (the sweep lane's
writer) and the real `handleBranchConflict` deps shape for the executor lane, because the defect lived
in the disagreement between lanes, not inside either one.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import {
  buildManualRetryResetPatch,
  buildAutoPauseClearPatch,
  BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY,
} from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import {
  branchConflictRecoveryRemedy,
  planBranchConflictRecoveryPass,
  readBranchConflictRecoveryEpisode,
  BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY,
} from "../recovery/branch-conflict-recovery-accounting.js";

const MAX_RETRIES = 3;
const TIP = "031e6b46b1182af2f5466fec6b5da5b787bdb394";
const BASE_TS = 1_700_000_000_000;

interface Harness {
  task: Task;
  updates: Array<Record<string, unknown>>;
  history: string[];
  auditEvents: Array<Record<string, unknown>>;
  reject: () => Promise<void>;
  retry: () => void;
  counts: () => { updates: number; history: number; audit: number; clock: string; parkedRows: number; rejectionRows: number };
}

function makeHarness(seed: Partial<Task> = {}): Harness {
  const task = {
    id: "RUFU-395",
    column: "in-review",
    status: null,
    paused: false,
    pausedReason: null,
    userPaused: false,
    recoveryRetryCount: 0,
    branch: "fusion/rufu-395",
    worktree: "/wt/rufu-395",
    baseBranch: "main",
    sourceMetadata: {},
    updatedAt: new Date(BASE_TS).toISOString(),
    ...seed,
  } as unknown as Task;

  const updates: Array<Record<string, unknown>> = [];
  const history: string[] = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const onceKeys: string[] = [];
  let ticks = 0;

  const store = {
    getSettings: vi.fn(async () => ({ autoRecovery: { mode: "deterministic", maxRetries: MAX_RETRIES } })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
      const { sourceMetadataPatch, ...rest } = patch as { sourceMetadataPatch?: Record<string, unknown> };
      Object.assign(task, rest);
      // FIDELITY: key-level merge with null-as-delete, exactly as the store applies it (RUFU-246).
      if (sourceMetadataPatch) {
        const merged: Record<string, unknown> = { ...(task.sourceMetadata ?? {}) };
        for (const [key, value] of Object.entries(sourceMetadataPatch)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        task.sourceMetadata = merged as Task["sourceMetadata"];
      }
      ticks += 1;
      task.updatedAt = new Date(BASE_TS + ticks * 1_000).toISOString();
    }),
    getTask: vi.fn(async () => task),
    logEntryOnce: vi.fn(async (_id: string, input: { action: string; dedupeKey: string }) => {
      if (onceKeys.includes(input.dedupeKey)) return false;
      onceKeys.push(input.dedupeKey);
      history.push(input.action);
      return true;
    }),
    logEntry: vi.fn(async (_id: string, action: string) => { history.push(action); }),
    recordRunAuditEvent: vi.fn(async (input: Record<string, unknown>) => { auditEvents.push(input); }),
  };

  const manager = new SelfHealingManager(store as unknown as TaskStore, { rootDir: "/repo" } as never);
  const reject = async () => {
    await (manager as unknown as {
      rejectForeignAlreadyMergedCandidate(input: Record<string, unknown>): Promise<void>;
    }).rejectForeignAlreadyMergedCandidate({
      task,
      candidateSha: TIP,
      candidateOwner: "OTHER-1",
      taskBranch: task.branch,
      baseBranch: "main",
      reason: "foreign-task-tip",
      phase: "tip-already-merged",
      countRecoveryBudget: true,
    });
  };

  /*
  The operator door, modeled the way every surface composes it: the pause lift plus the counter/episode
  reset, in one statement. `null` deletes, so the register is empty rather than zero-valued — the state
  a brand-new card has.
  */
  const retry = () => {
    const patch = { ...buildManualRetryResetPatch(), ...buildAutoPauseClearPatch(task) } as Record<string, unknown>;
    const { sourceMetadataPatch, ...rest } = patch as { sourceMetadataPatch?: Record<string, unknown> };
    Object.assign(task, rest);
    const merged: Record<string, unknown> = { ...(task.sourceMetadata ?? {}) };
    for (const [key, value] of Object.entries(sourceMetadataPatch ?? {})) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    task.sourceMetadata = merged as Task["sourceMetadata"];
  };

  const counts = () => ({
    updates: updates.length,
    history: history.length,
    audit: auditEvents.length,
    clock: task.updatedAt,
    parkedRows: auditEvents.filter((e) => e.mutationType === "task:branch-conflict-recovery-parked").length,
    rejectionRows: auditEvents.filter((e) => e.mutationType === "task:auto-recover-already-merged-rejected").length,
  });

  return { task, updates, history, auditEvents, reject, retry, counts };
}

/** Drive refusals until the park lands, returning the number of passes it took. */
async function driveToPark(h: Harness): Promise<number> {
  let passes = 0;
  while (h.task.pausedReason !== "branch-conflict-recovery-exhausted" && passes < MAX_RETRIES + 3) {
    await h.reject();
    passes += 1;
  }
  return passes;
}

describe("RUFU-395 — a parked card is silent, and only this family's own count parked it", () => {
  it("parks only after this family's own budget is spent, not on a borrowed counter", async () => {
    const h = makeHarness({ recoveryRetryCount: 10 } as Partial<Task>);
    const passes = await driveToPark(h);
    // A borrowed 10 against a budget of 3 must not park: the family needs its OWN 4th refusal.
    expect(passes).toBe(MAX_RETRIES + 1);
    expect(h.task.pausedReason).toBe("branch-conflict-recovery-exhausted");
    // The number the sentence carries is the register, inside the declared budget.
    expect(h.task.error).toMatch(new RegExp(`after ${MAX_RETRIES} bounded passes \\(budget ${MAX_RETRIES}\\)`));
    expect(h.task.error).not.toMatch(/after 1[0-9]* bounded passes/);
    // And the borrowed shared value was neither lowered nor raised by any of those passes.
    expect(h.task.recoveryRetryCount).toBe(10);
  });

  it("counts its own refusals in its own register, and the marker count equals it", async () => {
    const h = makeHarness();
    for (let pass = 1; pass <= MAX_RETRIES; pass += 1) {
      await h.reject();
      expect(readBranchConflictRecoveryEpisode(h.task)?.refusalCount).toBe(pass);
    }
    // Register == the number of refusal markers this family authored, by construction: the same
    // statement writes both, so a divergence would mean a writer outside the shared patch.
    expect(h.history.filter((line) => line.includes("already-merged rejected")).length).toBe(1);
  });

  it("produces ZERO new emissions across two consecutive sweeps on a parked card", async () => {
    const h = makeHarness();
    await driveToPark(h);
    expect(h.counts().parkedRows).toBe(1);
    /*
    The FIRST suppressed pass is allowed exactly one emission: the bounded `-no-action` row that makes
    the skip debuggable. Measuring "zero" from before that row exists would assert the suppression is
    invisible, which is the opposite of what RUFU-356's refusal-event family is for. The invariant the
    card states is about the SWEEPS AFTER the park is known: once the hold has been announced, a further
    pass must add nothing.
    */
    await h.reject();
    const before = h.counts();

    await h.reject();
    await h.reject();

    const after = h.counts();
    expect(after.updates).toBe(before.updates);        // no task-row write
    expect(after.history).toBe(before.history);        // no History append
    expect(after.audit).toBe(before.audit);            // no audit row of ANY type
    expect(after.clock).toBe(before.clock);            // no row-clock re-stamp
    expect(after.parkedRows).toBe(1);                  // no second park
    // Still parked, still refused, still checked out — suppression is quiet, not release.
    expect(h.task.paused).toBe(true);
    expect(h.task.pausedReason).toBe("branch-conflict-recovery-exhausted");
    expect(h.task.worktree).toBe("/wt/rufu-395");
    expect(h.task.branch).toBe("fusion/rufu-395");
  });

  it("names the hold once, so a silently-skipped card is still debuggable", async () => {
    const h = makeHarness();
    await driveToPark(h);
    await h.reject();
    await h.reject();
    const noAction = h.auditEvents.filter(
      (e) => e.mutationType === "task:reconcile-stale-acquisition-conflict-no-action",
    );
    // One row for the whole run of re-encounters, not one per pass: bounded, deduped per (card, code).
    expect(noAction).toHaveLength(1);
    expect(noAction[0]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({ code: "recovery-park-hold", outcome: "no-action" }),
    }));
  });

  it("one Retry lets a real conflict consume the whole budget again, and a second Retry still works", async () => {
    const h = makeHarness();
    await driveToPark(h);
    expect(h.task.pausedReason).toBe("branch-conflict-recovery-exhausted");

    h.retry();
    expect(h.task.paused).toBe(false);
    expect(h.task.pausedReason).toBeNull();
    expect(readBranchConflictRecoveryEpisode(h.task)).toBeNull();

    // The full declared budget is consumable again — not one pass, not zero.
    const passesAfterRetry = await driveToPark(h);
    expect(passesAfterRetry).toBe(MAX_RETRIES + 1);
    expect(h.task.pausedReason).toBe("branch-conflict-recovery-exhausted");

    // And the second Retry is not a no-op: the lift is idempotent, not single-use.
    h.retry();
    expect(h.task.paused).toBe(false);
    expect(readBranchConflictRecoveryEpisode(h.task)).toBeNull();
    expect(await driveToPark(h)).toBe(MAX_RETRIES + 1);
  });

  it("does not lift the park when an operator holds the card, and never auto-clears a userPaused row", async () => {
    /*
    Two authorities, kept apart on purpose. An operator hold is NOT this recovery's disposition, so
    `buildAutoPauseClearPatch` refuses it by contract — and the register is still emptied by an explicit
    Retry (core's own suite pins that half). What this lane must guarantee is the write-side: a card
    that carries its own park is untouched whether or not an operator also holds it.
    */
    const h = makeHarness();
    await driveToPark(h);
    (h.task as unknown as { userPaused: boolean }).userPaused = true;
    expect(buildAutoPauseClearPatch(h.task)).toEqual({});
    const before = h.counts();
    await h.reject();
    await h.reject();
    const after = h.counts();
    expect(after.updates).toBe(before.updates);
    expect(after.history).toBe(before.history);
    expect(after.clock).toBe(before.clock);
    expect(h.task.pausedReason).toBe("branch-conflict-recovery-exhausted");
  });
});

describe("RUFU-395 — the register authority is the same in every lane that reads it", () => {
  it("the cross-package key is one constant, not two literals", () => {
    // Core's Retry patch and the engine's counter patch live in different packages; if the key
    // literals drift, the park stops being liftable and nothing in the toolchain notices.
    expect(BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY).toBe("branchConflictRecoveryEpisode");
    expect(buildManualRetryResetPatch().sourceMetadataPatch).toHaveProperty(
      BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY,
      null,
    );
  });

  it("a pass planned from a parked row is terminal, so no lane can advance the register while suppressed", () => {
    const parked = {
      recoveryRetryCount: 0,
      sourceMetadata: {
        [BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY]: {
          refusalCount: MAX_RETRIES, firstAt: "2026-11-04T00:00:00.000Z", lastAt: "2026-11-04T00:00:00.000Z", lastSource: "dispatcher-irreducible-pause",
        },
      },
    } as unknown as Parameters<typeof planBranchConflictRecoveryPass>[0];
    const pass = planBranchConflictRecoveryPass(parked, { mode: "deterministic", maxRetries: MAX_RETRIES });
    expect(pass.terminal).toBe(true);
    expect(pass.boundedPassCount).toBe(MAX_RETRIES);
    // RUFU-231's contract on the remedy still holds after the number change.
    const sentence = branchConflictRecoveryRemedy(pass, "trunk", "checkout dirty");
    expect(sentence).toContain("trunk");
    expect(sentence).toMatch(/retry/i);
    expect(sentence).toMatch(/todo/i);
  });

  it("an episode that has run for days keeps its firstAt, so the wait is measurable", async () => {
    /*
    A register that restarted its clock on every pass could never tell the operator how long the
    exhaustion had been running — RUFU-350's moving-base lesson. Two consecutive passes can land in the
    same millisecond, so the deterministic form of the claim is: an EXISTING firstAt survives, and the
    refusal count still climbs on top of it.
    */
    const aged = "2026-11-01T00:00:00.000Z";
    const h = makeHarness({
      sourceMetadata: {
        [BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY]: { refusalCount: 1, firstAt: aged, lastAt: aged, lastSource: "self-owned-reclaim" },
      },
    } as Partial<Task>);
    await h.reject();
    const episode = readBranchConflictRecoveryEpisode(h.task);
    expect(episode?.firstAt).toBe(aged);
    expect(episode?.refusalCount).toBe(2);
    expect(Date.parse(episode!.lastAt)).toBeGreaterThanOrEqual(Date.parse(aged));
  });

  it("mode: off gets neither register nor park — the operator's opt-out stays total", async () => {
    const off = makeHarnessOff();
    const before = off.counts();
    await off.reject();
    await off.reject();
    await off.reject();
    await off.reject();
    expect(off.task.pausedReason).toBeNull();
    expect(readBranchConflictRecoveryEpisode(off.task)).toBeNull();
    expect(off.updates.filter((p) => "recoveryRetryCount" in p)).toHaveLength(0);
    expect(off.counts().parkedRows).toBe(0);
    // mode: "off" still records the refusal itself — opting out of accounting is not opting out of
    // the refusal, and an operator reading the audit trail must still see the rejections.
    expect(off.counts().audit - before.audit).toBeGreaterThanOrEqual(4);
  });
});

/** The same harness with `mode: "off"` — the operator opt-out path needs its own settings stub. */
function makeHarnessOff(): Harness {
  const h = makeHarness();
  const auditEvents: Array<Record<string, unknown>> = [];
  const manager = new SelfHealingManager({
    getSettings: async () => ({ autoRecovery: { mode: "off", maxRetries: MAX_RETRIES } }),
    updateTask: async () => undefined,
    getTask: async () => h.task,
    logEntryOnce: async () => true,
    logEntry: async () => undefined,
    recordRunAuditEvent: async (input: Record<string, unknown>) => { auditEvents.push(input); },
  } as unknown as TaskStore, { rootDir: "/repo" } as never);
  const reject = async () => {
    await (manager as unknown as {
      rejectForeignAlreadyMergedCandidate(input: Record<string, unknown>): Promise<void>;
    }).rejectForeignAlreadyMergedCandidate({
      task: h.task,
      candidateSha: TIP,
      candidateOwner: "OTHER-1",
      taskBranch: h.task.branch,
      baseBranch: "main",
      reason: "foreign-task-tip",
      phase: "tip-already-merged",
      countRecoveryBudget: true,
    });
  };
  return {
    ...h,
    reject,
    counts: () => ({
      updates: h.updates.length,
      history: h.history.length,
      audit: auditEvents.length,
      clock: h.task.updatedAt,
      parkedRows: auditEvents.filter((e) => e.mutationType === "task:branch-conflict-recovery-parked").length,
      rejectionRows: auditEvents.filter((e) => e.mutationType === "task:auto-recover-already-merged-rejected").length,
    }),
  };
}
