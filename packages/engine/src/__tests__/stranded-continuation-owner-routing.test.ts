import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { HumanMergeApprovalState, Settings, Task, TaskStore, WorkflowIr, WorkflowWorkItem } from "@fusion/core";
import {
  HUMAN_MERGE_APPROVAL_HOLD_MARKER,
  buildHumanMergeHoldMarker,
  describeHumanMergeHoldSignature,
} from "@fusion/core";

const { recordRunAuditEventMock, resolveTaskLifecycleColumnsMock, resolveWorkflowIrForTaskMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async (_event: { type?: string }) => undefined),
  resolveTaskLifecycleColumnsMock: vi.fn(),
  resolveWorkflowIrForTaskMock: vi.fn(),
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveTaskLifecycleColumns: resolveTaskLifecycleColumnsMock,
  resolveWorkflowIrForTask: resolveWorkflowIrForTaskMock,
}));
vi.mock("../util/run-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/run-audit.js")>()),
  createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock })),
}));

import { SelfHealingManager, type SelfHealingOptions } from "../self-healing.js";
import {
  CLAIMABLE_HOLD_REASON_PREFIXES,
  DEPENDENCY_HOLD_REASON_PREFIX,
  FILE_SCOPE_HOLD_REASON_PREFIX,
  RECLAIM_DEFERRAL_HORIZON_MS,
  RECLAIM_DEFERRAL_LADDER_MS,
  evaluateStrandedContinuationReclaim,
} from "../workflows/stranded-continuation-reclaim.js";
import { releaseFileScopeWaitingContinuations, releaseHumanMergeApprovalHolds } from "../runtimes/in-process-runtime.js";
import { evaluateStrandedHoldContinuation } from "../plan-review-continuation.js";
import { isHumanMergeAdmissionHold } from "../executor/workflow-admission-hold.js";

/*
FNXC:StrandedContinuationReclaim 2026-09-22-14:21 (RUFU-263):
The reclaim sweep used to answer every non-empty `blockedReason` with the same two writes — a forced
`runnable` transition plus a `[recovery]` card-history line — because the fallthrough in
`evaluateStrandedContinuationReclaim` never read the reason at all. On a `held` row that pair repeats every
~15-minute maintenance pass: the census this task required measured 5,914 of 7,038 retained recovery rows
(84%) in exactly that shape, and RUFU-220 accumulated 782 identical `[recovery]` lines while the card never
moved off `todo`.

`held` is not one condition, and the test below asserts the disposition each condition is owed:

  - A reason in the store's claimable-hold families (`workflow-principal-%`, `workflow-named-principal-%`,
    `workflow-role-pool-%`) is a wait the scheduler's own claim predicate can re-take. FN-8923 is the named
    recovery seam for the planning lane. Pure suppression: the sweep must write NOTHING, because deferring
    these rows would set `retryAfter`, and the claim path lists through the same due-gate.
  - An FN-514 human-merge hold (`workflow-human-merge-approval*`) is a wait `releaseHumanMergeApprovalHolds`
    releases — and that releaser also reads through the due-gated held listing, so suppression is again the
    only safe disposition.
  - A file-scope wait (`file-scope:<blockerId>`) is owned by `releaseFileScopeWaitingContinuations`, which
    lists work items for the task (not due-gated), so a suppression here is safe while the task still names
    the blocker; a reason naming a blocker the task no longer has is an orphan and a reclaim is real recovery.
  - `dependency:<taskId>` has no dedicated releaser, so it gets the sweep's bounded re-check: a durable
    `retryAfter` on the ladder while the task still depends on the named blocker.

Surface enumeration for the invariant: the classifier is asserted per reason family (principal × 3 shapes,
human-merge, file-scope live/stale, dependency live/stale, dependency-configuration-block, unknown, empty),
across the ladder's three widths, and at the caller for each of the four dispositions (none / defer / requeue
/ retire-free reclaim), including the restart case where only the durable row remains.
*/

const GRACE_EXCEEDED = 20 * 60_000;
const FIVE_MINUTES = 5 * 60_000;
const THIRTY_MINUTES = RECLAIM_DEFERRAL_LADDER_MS[0];
const TWO_HOURS = RECLAIM_DEFERRAL_LADDER_MS[1];

/** Classifier inputs for a stale-enough `held` row — the only shape the hold branch can reach. */
function heldInput(blockedReason: string | null, extra: Record<string, unknown> = {}) {
  const now = 1_800_000_000_000;
  return {
    item: {
      state: "held" as const, kind: "task" as const, taskId: "RUFU-263", nodeId: "plan-review",
      retryAfter: null, leaseExpiresAt: null, blockedReason,
    },
    taskMissing: false, taskTerminal: false, taskPaused: false,
    live: false, enginePaused: false,
    stalenessMs: GRACE_EXCEEDED, graceMs: 600_000, now,
    ...extra,
  } as Parameters<typeof evaluateStrandedContinuationReclaim>[0];
}

describe("evaluateStrandedContinuationReclaim — hold ownership routing", () => {
  it("suppresses every claimable-hold family the store's own claim predicate can re-take", () => {
    for (const reason of [
      "workflow-principal-unavailable",
      "workflow-principal-routing-unavailable:missing-agentRef:executor",
      "workflow-named-principal-unavailable:fence-mismatch",
      "workflow-role-pool-exhausted:executor",
    ]) {
      expect(evaluateStrandedContinuationReclaim(heldInput(reason)), reason).toEqual({
        action: "none", reason: "principal-routing-hold",
      });
    }
  });

  it("suppresses an FN-514 human-merge hold regardless of its signature", () => {
    // Pure suppression is deliberate here: the owning releaser compares the signature itself, and it reads
    // through the due-gated `held` listing — a deferral stamped by this sweep would hide the row from the
    // one seam allowed to clear it.
    for (const reason of [
      `${HUMAN_MERGE_APPROVAL_HOLD_MARKER}-pending#sig-current`,
      `${HUMAN_MERGE_APPROVAL_HOLD_MARKER}-failed#sig-from-an-earlier-sha`,
    ]) {
      expect(evaluateStrandedContinuationReclaim(heldInput(reason)), reason).toEqual({
        action: "none", reason: "human-merge-approval-hold",
      });
    }
  });

  it("suppresses a file-scope wait while the task still names its blocker, and re-queues an orphaned one", () => {
    const live = { taskOverlapBlockedBy: "RUFU-128" };
    expect(evaluateStrandedContinuationReclaim(heldInput(`${FILE_SCOPE_HOLD_REASON_PREFIX}RUFU-128`, live)))
      .toEqual({ action: "none", reason: "file-scope-hold" });
    // The blocker moved on but the wait row did not: the release sweep keys off the lease, not this row, so
    // nothing else would ever re-drive it. Recovery here is genuine.
    expect(evaluateStrandedContinuationReclaim(heldInput(`${FILE_SCOPE_HOLD_REASON_PREFIX}RUFU-128`, {
      taskOverlapBlockedBy: "RUFU-999",
    }))).toEqual({ action: "requeue", reason: "stale-file-scope-hold", announceRecovery: true });
    expect(evaluateStrandedContinuationReclaim(heldInput(`${FILE_SCOPE_HOLD_REASON_PREFIX}RUFU-128`)))
      .toEqual({ action: "requeue", reason: "stale-file-scope-hold", announceRecovery: true });
  });

  it("defers a dependency wait while the task still depends on the named blocker, and re-queues once it does not", () => {
    const first = evaluateStrandedContinuationReclaim(heldInput(`${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`, {
      taskBlockedBy: "RUFU-196",
    }));
    expect(first.action).toBe("defer");
    expect(first).toMatchObject({ reason: "dependency-hold", retryAfterMs: 1_800_000_000_000 + THIRTY_MINUTES });

    // Same reason, dependency cleared or re-pointed elsewhere: the wait is stale and the row must run again.
    for (const extra of [{}, { taskBlockedBy: "RUFU-777" }]) {
      expect(evaluateStrandedContinuationReclaim(heldInput(`${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`, extra)))
        .toEqual({ action: "requeue", reason: "stale-dependency-hold", announceRecovery: true });
    }
    // FN-226's configuration cycle is a dependency block by another name, so it earns the same bound.
    expect(evaluateStrandedContinuationReclaim(heldInput("dependency-configuration-blocked", {
      taskBlockedBy: "RUFU-196",
    }))).toMatchObject({ action: "defer", reason: "dependency-hold" });
  });

  it("keeps an unknown or empty hold recoverable on first sight and bounded on the second", () => {
    // The 46-hour two-card incident this sweep was built for carried a NULL reason. That class must stay
    // recoverable, so the FIRST pass is always a re-queue — with a card-history line — whatever the reason.
    for (const reason of [null, "", "manual merge required", "autoMerge:false", "some-reason-we-do-not-own"]) {
      expect(evaluateStrandedContinuationReclaim(heldInput(reason)), String(reason)).toEqual({
        action: "requeue", reason: "unclaimable-hold", announceRecovery: true,
      });
    }
    // A hold the caller has already announced once is still an unknown wait: recover it again, but stop
    // writing the same sentence to the card and the event store every pass.
    for (const reason of [null, "some-reason-we-do-not-own"]) {
      expect(evaluateStrandedContinuationReclaim(heldInput(reason, { alreadyAnnounced: true })), String(reason))
        .toMatchObject({ action: "defer", reason: "unclaimable-sustained" });
    }
  });

  it("advances the deferral ladder from the durable evidence on the row itself", () => {
    const now = 1_800_000_000_000;
    // The row's own `updatedAt` is when the previous pass stamped it, so `retryAfter - updatedAt` is the
    // width that pass chose. Three passes must therefore be 30m, then 2h, then 6h.
    const widths = [null, THIRTY_MINUTES, TWO_HOURS];
    const expected = [THIRTY_MINUTES, TWO_HOURS, RECLAIM_DEFERRAL_LADDER_MS[2]];
    for (let pass = 0; pass < widths.length; pass += 1) {
      const verdict = evaluateStrandedContinuationReclaim(heldInput(`${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`, {
        taskBlockedBy: "RUFU-196",
        item: {
          state: "held", kind: "task", taskId: "RUFU-263", nodeId: "plan-review",
          leaseExpiresAt: null, blockedReason: `${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`,
          retryAfter: widths[pass] === null ? null : new Date(now - GRACE_EXCEEDED + widths[pass]!).toISOString(),
        },
      }));
      expect(verdict, `pass ${pass}`).toMatchObject({ action: "defer", retryAfterMs: now + expected[pass] });
    }
    // Past the ladder's top the sweep keeps re-checking at that ceiling — it never stops looking, because a
    // dependency hold has no other seam to re-drive it.
    const ceiling = evaluateStrandedContinuationReclaim(heldInput(`${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`, {
      taskBlockedBy: "RUFU-196",
      item: {
        state: "held", kind: "task", taskId: "RUFU-263", nodeId: "plan-review",
        leaseExpiresAt: null, blockedReason: `${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`,
        retryAfter: new Date(now - GRACE_EXCEEDED + RECLAIM_DEFERRAL_LADDER_MS[2]).toISOString(),
      },
    }));
    expect(ceiling).toMatchObject({ action: "defer", retryAfterMs: now + RECLAIM_DEFERRAL_LADDER_MS[2] });
  });

  it("never defers a family whose owning seam reads through the due-gated listing", () => {
    // A deferral is `retryAfter`, and `claimDueWorkflowWorkItem` / `releaseHumanMergeApprovalHolds` list
    // through the same due-gate. If a future edit "fixes" churn by deferring these, the row becomes
    // invisible to the only seam allowed to release it — a permanent freeze. This is that ratchet.
    for (const reason of [
      "workflow-role-pool-exhausted:executor",
      "workflow-named-principal-unavailable:fence-mismatch",
      `${HUMAN_MERGE_APPROVAL_HOLD_MARKER}-pending#sig`,
      `${FILE_SCOPE_HOLD_REASON_PREFIX}RUFU-128`,
    ]) {
      const verdict = evaluateStrandedContinuationReclaim(heldInput(reason, {
        taskOverlapBlockedBy: "RUFU-128",
        item: {
          state: "held", kind: "task", taskId: "RUFU-263", nodeId: "plan-review",
          leaseExpiresAt: null, blockedReason: reason,
          retryAfter: new Date(1_800_000_000_000 + TWO_HOURS).toISOString(),
        },
      }));
      expect(verdict.action, reason).toBe("none");
    }
  });

  it("leaves non-held dispositions untouched by reason routing", () => {
    // A lease-expired `running` row has no wait to honour: it disposes as the dead lease it is, and a
    // principal-family reason on it must not suppress the reclaim (that is the FN-8902 incident shape).
    expect(evaluateStrandedContinuationReclaim({
      ...heldInput("workflow-role-pool-exhausted:executor"),
      item: {
        state: "running", kind: "task", taskId: "RUFU-263", nodeId: "plan-review",
        retryAfter: null, leaseExpiresAt: null, blockedReason: "workflow-role-pool-exhausted:executor",
      },
    } as Parameters<typeof evaluateStrandedContinuationReclaim>[0]))
      .toEqual({ action: "requeue", reason: "dead-lease", announceRecovery: true });
    // A live session is still proof of life even with a reason in hand.
    expect(evaluateStrandedContinuationReclaim({
      ...heldInput(`${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`, { live: true, taskBlockedBy: "RUFU-196" }),
    })).toEqual({ action: "none", reason: "live-session" });
  });

  /* ── RUFU-299: the deferral horizon ────────────────────────────────── */

  /*
  FNXC:StrandedContinuationDeferralHorizon 2026-11-02-12:27 (RUFU-299):
  These cases are the whole "bounded" promise, asserted on the returned disposition because that is what the
  sweep acts on: an unbounded ladder hid the card from the store-wide due gate, so the fix has to be
  observable as a DECISION before it is observable as a write. The ladder itself is unchanged — the horizon is
  an absolute bound on an episode, not a shorter ladder.
  */
  describe("deferral horizon (RUFU-299)", () => {
    // Same instant `heldInput` defaults to, named here so the anchor and the rung are computed from one clock.
    const NOW = 1_800_000_000_000;
    const DAY = 24 * 3_600_000;
    const HORIZON = RECLAIM_DEFERRAL_HORIZON_MS;
    const TOP_RUNG = RECLAIM_DEFERRAL_LADDER_MS[RECLAIM_DEFERRAL_LADDER_MS.length - 1]!;

    /** A held row whose episode anchor sits `ageMs` in the past and whose rung has already saturated. */
    function agedHold(ageMs: number, extra: Record<string, unknown> = {}) {
      return heldInput(`${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`, {
        taskBlockedBy: "RUFU-196",
        deferralHorizonMs: HORIZON,
        item: {
          state: "held", kind: "task", taskId: "RUFU-263", nodeId: "plan-review",
          leaseExpiresAt: null, blockedReason: `${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`,
          retryAfter: new Date(NOW - GRACE_EXCEEDED + TOP_RUNG).toISOString(),
          deferredSince: new Date(NOW - ageMs).toISOString(),
        },
        ...extra,
      });
    }

    it("reveals instead of deferring once the episode passes the horizon", () => {
      // One millisecond short of the bound the ladder still behaves normally: the reveal is a threshold, not
      // an extra pass that always fires.
      expect(evaluateStrandedContinuationReclaim(agedHold(HORIZON - 1)))
        .toMatchObject({ action: "defer", reason: "dependency-hold", sustained: true });

      expect(evaluateStrandedContinuationReclaim(agedHold(HORIZON)))
        .toEqual({ action: "reveal", reason: "dependency-hold", deferralAgeMs: HORIZON });

      // The unclaimable-sustained branch reveals too — it is the other reason with no named owner.
      expect(evaluateStrandedContinuationReclaim(heldInput(null, {
        alreadyAnnounced: true,
        deferralHorizonMs: HORIZON,
        item: {
          state: "held", kind: "task", taskId: "RUFU-263", nodeId: "plan-review",
          leaseExpiresAt: null, blockedReason: null,
          retryAfter: new Date(NOW - GRACE_EXCEEDED + TOP_RUNG).toISOString(),
          deferredSince: new Date(NOW - HORIZON - DAY).toISOString(),
        },
      }))).toEqual({ action: "reveal", reason: "unclaimable-sustained", deferralAgeMs: HORIZON + DAY });
    });

    it("never reveals without a horizon, an anchor, or finite anchor evidence", () => {
      // Pre-RUFU-299 call sites behave exactly as before: no horizon means never reveal.
      expect(evaluateStrandedContinuationReclaim(agedHold(HORIZON * 4, { deferralHorizonMs: undefined })))
        .toMatchObject({ action: "defer", sustained: true });

      // No anchor means no episode clock, so an aged `retryAfter` alone must never trigger a reveal. This is
      // the RUFU-547 hazard stated as an assertion — keying the horizon off `retryAfter` would reveal here.
      const noAnchor = agedHold(HORIZON * 4);
      (noAnchor.item as { deferredSince: string | null }).deferredSince = null;
      expect(evaluateStrandedContinuationReclaim(noAnchor)).toMatchObject({ action: "defer" });

      // An unparseable stamp is not evidence of an elapsed episode, and neither is a clock anomaly.
      for (const stamp of ["not-a-timestamp", new Date(NOW + DAY).toISOString()]) {
        const junk = agedHold(HORIZON * 4);
        (junk.item as { deferredSince: string | null }).deferredSince = stamp;
        expect(evaluateStrandedContinuationReclaim(junk), stamp).toMatchObject({ action: "defer" });
      }
    });

    it("marks sustained exactly from the pass whose rung saturates", () => {
      // The climb is the ladder working; the first RE-APPLICATION of the top rung is the state the horizon
      // exists to end. One ladder walk, three rungs, then the ceiling forever.
      const widths: Array<number | null> = [null, THIRTY_MINUTES, TWO_HOURS, TOP_RUNG, TOP_RUNG];
      const expectedRungs = [THIRTY_MINUTES, TWO_HOURS, TOP_RUNG, TOP_RUNG, TOP_RUNG];
      const expectedSustained = [false, false, false, true, true];
      widths.forEach((width, pass) => {
        const verdict = evaluateStrandedContinuationReclaim(heldInput(`${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`, {
          taskBlockedBy: "RUFU-196",
          item: {
            state: "held", kind: "task", taskId: "RUFU-263", nodeId: "plan-review",
            leaseExpiresAt: null, blockedReason: `${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`,
            retryAfter: width === null ? null : new Date(NOW - GRACE_EXCEEDED + width).toISOString(),
          },
        }));
        expect(verdict, `pass ${pass}`).toMatchObject({ action: "defer", retryAfterMs: NOW + expectedRungs[pass]! });
        expect("sustained" in verdict, `pass ${pass} sustained key`).toBe(expectedSustained[pass]);
      });
    });

    it("keeps converge ahead of reveal and every named owner ahead of both", () => {
      // RUFU-285's precedence survives the new branch: an evidenced overlap wait converges onto the blocker
      // the task row proves, instead of having its deferral cleared out from under that blocker. A NULL reason
      // is the shape that reaches the converge branch at all — the dependency prefix is decided earlier.
      expect(evaluateStrandedContinuationReclaim(heldInput(null, {
        alreadyAnnounced: true,
        taskOverlapBlockedBy: "RUFU-128",
        overlapBlockerLive: true,
        overlapHolderLive: true,
        deferralHorizonMs: HORIZON,
        item: {
          state: "held", kind: "task", taskId: "RUFU-263", nodeId: "plan-review",
          leaseExpiresAt: null, blockedReason: null,
          retryAfter: new Date(NOW - GRACE_EXCEEDED + TOP_RUNG).toISOString(),
          deferredSince: new Date(NOW - HORIZON - DAY).toISOString(),
        },
      }))).toMatchObject({ action: "converge" });

      // A named owner is suppressed BEFORE the horizon is consulted, so a scheduler- or engine-owned hold is
      // never revealed out from under the seam that owns it.
      const guards: Array<[{ [k: string]: unknown }, "none" | "requeue", string]> = [
        [{ enginePaused: true }, "none", "engine-paused"],
        [{ taskPaused: true }, "none", "operator-paused"],
        [{ live: true }, "none", "live-session"],
        [{ planningLive: true }, "none", "live-planning"],
        [{ stalenessMs: 599_999 }, "none", "too-fresh"],
        [{ taskTerminal: true }, "retire", "task-terminal"],
        // The dependency proof itself outranks the horizon: a wait whose blocker is gone re-queues instead.
        [{ taskBlockedBy: "RUFU-777" }, "requeue", "stale-dependency-hold"],
      ];
      for (const [extra, expected, why] of guards) {
        const verdict = evaluateStrandedContinuationReclaim(agedHold(HORIZON * 4, extra));
        expect(verdict.action, why).toBe(expected);
      }

      // A held row whose lease has not expired is still not the horizon's to harvest: the `running` lease
      // proof and the grace window both outrank it, and a `manual-hold` kind never reaches the ladder at all.
      const manual = agedHold(HORIZON * 4, {
        item: {
          state: "held", kind: "manual-hold", taskId: "RUFU-263", nodeId: "plan-review",
          blockedReason: `${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`,
          retryAfter: new Date(NOW - GRACE_EXCEEDED + TOP_RUNG).toISOString(),
          deferredSince: new Date(NOW - HORIZON * 4).toISOString(),
          leaseExpiresAt: null,
        },
      });
      expect(evaluateStrandedContinuationReclaim(manual)).toEqual({ action: "none", reason: "manual-hold" });
      const leased = agedHold(HORIZON * 4, {
        item: {
          state: "running", kind: "task", taskId: "RUFU-263", nodeId: "plan-review",
          blockedReason: `${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`,
          retryAfter: new Date(NOW - GRACE_EXCEEDED + TOP_RUNG).toISOString(),
          deferredSince: new Date(NOW - HORIZON * 4).toISOString(),
          leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
        },
      });
      expect(evaluateStrandedContinuationReclaim(leased)).toEqual({ action: "none", reason: "lease-active" });
    });
  });
});

/* ── RUFU-285: convergence to the wait the task row proves ────────────────── */

/*
FNXC:StrandedContinuationReclaim 2026-09-26-02:40 (RUFU-285):
RUFU-263's dedup cannot reach a card whose re-holding writer replaces the row instead of CAS-ing it: the
process-local memo is keyed on `taskId|nodeId|state|blockedReason`, and the reason oscillates (NULL from the
capacity `onSuspend`, `plan-review-close-*` from the planning-close hold) while the re-queue itself nulls
`retryAfter`, erasing the durable width the ladder reads back. RUFU-254 measured 402 `[recovery]` lines in 6
days at a 72–85/day cadence for exactly that shape, with zero `-no-action` (defer) rows ever written.

The durable truth that survives all of that is on the **task** row: `overlapBlockedBy` names the card whose
file-scope lease is being waited for, published by `transitionQueuedEpisode`. When the holder is live, that
pair proves the wait is real, so the sweep **converges** the row to the reason the shipped releaser matches
(`file-scope:<holderId>`) and stamps the ladder in the same write — no re-queue, no `[recovery]` line, no
planner wake. The block below pins that contract and, just as loudly, the shapes that must keep re-queuing.
*/

describe("evaluateStrandedContinuationReclaim — a hold the task row proves is another card's lease wait", () => {
  const NOW = 1_800_000_000_000;
  const LIVE_OVERLAP = { taskOverlapBlockedBy: "RUFU-257", overlapHolderLive: true };
  const CONVERGED_REASON = `${FILE_SCOPE_HOLD_REASON_PREFIX}RUFU-257`;

  it("converges an unowned held reason to the canonical file-scope wait instead of re-queuing", () => {
    // The two shapes the live loop actually presented, plus the blank string a writer can leave behind.
    for (const reason of [null, "", "plan-review-close-capacity"]) {
      const verdict = evaluateStrandedContinuationReclaim(heldInput(reason, LIVE_OVERLAP));
      expect(verdict, String(reason)).toEqual({
        action: "converge",
        reason: "file-scope-wait-converged",
        ownedReason: CONVERGED_REASON,
        retryAfterMs: NOW + THIRTY_MINUTES,
      });
      // `announceRecovery` is the only thing that writes the card-history line; convergence must not carry it.
      expect("announceRecovery" in (verdict as object), String(reason)).toBe(false);
    }
  });

  it("leaves an already-owned match on the shipped suppression and an owned mismatch on the shipped orphan re-queue", () => {
    // These two are the converged row's whole after-life: it must read as an ordinary file-scope wait, and
    // drift in the task-level blocker must recover it. Neither may become a new disposition.
    expect(evaluateStrandedContinuationReclaim(heldInput(CONVERGED_REASON, LIVE_OVERLAP)))
      .toEqual({ action: "none", reason: "file-scope-hold" });
    expect(evaluateStrandedContinuationReclaim(heldInput(`${FILE_SCOPE_HOLD_REASON_PREFIX}RUFU-999`, LIVE_OVERLAP)))
      .toEqual({ action: "requeue", reason: "stale-file-scope-hold", announceRecovery: true });
  });

  it("converges ahead of the wedge-class sustained ladder, whatever the memo claims", () => {
    // The memo cannot be trusted for this class (that is the bug), so convergence is unconditional on the
    // durable proof rather than an optional extra gated on `alreadyAnnounced`.
    expect(evaluateStrandedContinuationReclaim(heldInput(null, { ...LIVE_OVERLAP, alreadyAnnounced: true })))
      .toMatchObject({ action: "converge", reason: "file-scope-wait-converged" });
  });

  it("keeps the first-sight re-queue for every way the overlap proof can be missing or false", () => {
    const WEDGE = { action: "requeue", reason: "unclaimable-hold", announceRecovery: true };
    for (const [label, extra] of [
      ["no blocker named at all", {}],
      ["blank blocker id", { taskOverlapBlockedBy: "  " }],
      // The holder resolved but sits in a terminal column, is soft-deleted, or did not resolve: in every one
      // of those cases nobody holds the lease, so the wedge-class recovery is the honest answer.
      ["holder proof omitted", { taskOverlapBlockedBy: "RUFU-257" }],
      ["holder proof false", { taskOverlapBlockedBy: "RUFU-257", overlapHolderLive: false }],
      ["card blocked by itself", { taskOverlapBlockedBy: "RUFU-263", overlapHolderLive: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      for (const reason of [null, "plan-review-close-capacity"]) {
        expect(evaluateStrandedContinuationReclaim(heldInput(reason, extra)), `${label}/${reason}`)
          .toEqual(WEDGE);
      }
    }
  });

  it("does not converge a row a claim owns mid-cycle", () => {
    // Convergence writes `blockedReason` and a deferral stamp on a row it believes is unowned; a live
    // `leaseOwner` means a dispatcher is mid-claim on it, and clobbering that is a double-dispatch risk.
    expect(evaluateStrandedContinuationReclaim(heldInput(null, {
      ...LIVE_OVERLAP,
      item: {
        state: "held", kind: "task", taskId: "RUFU-263", nodeId: "plan-review", leaseOwner: "engine-lease-1",
        retryAfter: null, leaseExpiresAt: null, blockedReason: null,
      },
    }))).toEqual({ action: "requeue", reason: "unclaimable-hold", announceRecovery: true });
  });

  it("advances the convergence width on the same ladder and keeps deferring at its ceiling", () => {
    // (d) of the freeze-safety set: the ceiling is a 6 h re-check, never a re-queue. The shipped ladder has no
    // ceiling re-queue and this design must not invent one — a converged card that re-queued at 6 h would
    // reproduce the symptom it replaces, just slower.
    const widths = [null, THIRTY_MINUTES, TWO_HOURS, RECLAIM_DEFERRAL_LADDER_MS[2]];
    const expected = [THIRTY_MINUTES, TWO_HOURS, RECLAIM_DEFERRAL_LADDER_MS[2], RECLAIM_DEFERRAL_LADDER_MS[2]];
    for (let pass = 0; pass < widths.length; pass += 1) {
      const verdict = evaluateStrandedContinuationReclaim(heldInput(null, {
        ...LIVE_OVERLAP,
        item: {
          state: "held", kind: "task", taskId: "RUFU-263", nodeId: "plan-review",
          leaseExpiresAt: null, blockedReason: null,
          retryAfter: widths[pass] === null ? null : new Date(NOW - GRACE_EXCEEDED + widths[pass]!).toISOString(),
        },
      }));
      expect(verdict, `pass ${pass}`).toMatchObject({
        action: "converge", ownedReason: CONVERGED_REASON, retryAfterMs: NOW + expected[pass],
      });
    }
  });

  it("never converges a reason another seam already owns", () => {
    // The convergence branch sits BELOW the owned-family branches, so these keep their shipped dispositions —
    // a deferral stamped here would hide the row from the seam that releases it.
    for (const reason of [
      "workflow-role-pool-exhausted:executor",
      `${HUMAN_MERGE_APPROVAL_HOLD_MARKER}-pending#sig`,
      `${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`,
    ]) {
      const verdict = evaluateStrandedContinuationReclaim(heldInput(reason, {
        ...LIVE_OVERLAP, taskBlockedBy: "RUFU-196",
      }));
      expect(verdict.action, reason).not.toBe("converge");
    }
  });
});

/* ── Caller-level dispositions ─────────────────────────────────────────────── */

const staleFrom = (ms: number) => new Date(Date.now() - ms).toISOString();

function workItem(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: "wi-263", runId: "run-263", taskId: "RUFU-263", nodeId: "plan-review", kind: "task",
    state: "held", attempt: 0, retryAfter: null,
    leaseOwner: null, leaseExpiresAt: null, lastError: null, blockedReason: null,
    createdAt: staleFrom(GRACE_EXCEEDED), updatedAt: staleFrom(GRACE_EXCEEDED),
    ...overrides,
  } as unknown as WorkflowWorkItem;
}

/**
 * Harness over one mutable due-list so a single manager can be run through several maintenance passes,
 * which is the only way to observe the once-per-condition promises.
 */
function harness(
  items: WorkflowWorkItem[],
  taskOverrides: Partial<Task> = {},
  managerOptions: Partial<SelfHealingOptions> = {},
) {
  const task = {
    id: "RUFU-263", title: "Bound the stranded-continuation sweep", description: "", column: "todo",
    dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: staleFrom(GRACE_EXCEEDED), updatedAt: staleFrom(GRACE_EXCEEDED),
    ...taskOverrides,
  } as unknown as Task;
  const transitions: Array<{ id: string; state: string; patch: Record<string, unknown> }> = [];
  const logged: string[] = [];
  let current = items;
  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    listDueWorkflowWorkItems: vi.fn(async () => current),
    getTask: vi.fn(async (id: string) => (id === task.id ? task : undefined)),
    transitionWorkflowWorkItem: vi.fn(async (id: string, state: string, patch: Record<string, unknown>) => {
      transitions.push({ id, state, patch });
      return { ...current.find((entry) => entry.id === id)!, state };
    }),
    logEntry: vi.fn(async (_id: string, message: string) => { logged.push(message); }),
    getRootDir: vi.fn(() => "/repo"),
    getTasksDir: vi.fn(() => ""),
  } as unknown as TaskStore;
  resolveTaskLifecycleColumnsMock.mockResolvedValue({ complete: "done" });
  return {
    store,
    transitions,
    logged,
    manager: new SelfHealingManager(store, { rootDir: "/repo", ...managerOptions }),
    /** Feed the next pass a new snapshot of the row, as the real table would after its own writes. */
    nextPass(next: WorkflowWorkItem[]) { current = next; },
  };
}

describe("reconcileStrandedWorkflowContinuations — owner routing at the caller", () => {
  it("writes nothing at all for a hold another seam owns", async () => {
    const cases: Array<{ label: string; blockedReason: string; task?: Partial<Task> }> = [
      { label: "principal routing", blockedReason: "workflow-role-pool-exhausted:executor" },
      { label: "principal unavailable", blockedReason: "workflow-principal-unavailable" },
      { label: "named principal", blockedReason: "workflow-named-principal-unavailable:fence-mismatch" },
      { label: "human merge approval", blockedReason: `${HUMAN_MERGE_APPROVAL_HOLD_MARKER}-pending#sig` },
      {
        label: "file scope with a live blocker",
        blockedReason: `${FILE_SCOPE_HOLD_REASON_PREFIX}RUFU-128`,
        task: { overlapBlockedBy: "RUFU-128" },
      },
    ];
    for (const { label, blockedReason, task } of cases) {
      recordRunAuditEventMock.mockClear();
      const { manager, transitions, logged } = harness([workItem({ blockedReason })], task);

      await expect(manager.reconcileStrandedWorkflowContinuations(), label).resolves.toBe(0);

      expect(transitions, label).toEqual([]);
      expect(logged, label).toEqual([]);
      expect(recordRunAuditEventMock.mock.calls.map((call) => call[0]?.type), label).toEqual([]);
    }
  });

  it("defers a dependency hold on the durable ladder without touching its state or reason", async () => {
    recordRunAuditEventMock.mockClear();
    const { manager, transitions, logged } = harness(
      [workItem({ blockedReason: `${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196` })],
      { blockedBy: "RUFU-196" },
    );
    const before = Date.now();

    // The sweep's return value counts actual mutations; a deferral is deliberately not a reclaim.
    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);

    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.state).toBe("held");
    const patch = transitions[0]?.patch ?? {};
    const stamped = new Date(String(patch.retryAfter)).getTime();
    expect(stamped - before).toBeGreaterThanOrEqual(THIRTY_MINUTES - FIVE_MINUTES);
    expect(stamped - before).toBeLessThanOrEqual(THIRTY_MINUTES + FIVE_MINUTES);
    // The reason IS the evidence the next pass re-reads; a deferral must not clear it, the lease, or the error.
    expect(patch).not.toHaveProperty("blockedReason");
    expect(patch).not.toHaveProperty("leaseOwner");
    expect(patch).not.toHaveProperty("lastError");
    expect(logged).toEqual([]);
    expect(recordRunAuditEventMock).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "workflowWorkItem:reconcile-stranded-no-action",
      metadata: expect.objectContaining({
        taskId: "RUFU-263", nodeId: "plan-review", priorState: "held", reason: "dependency-hold",
      }),
    }));
  });

  it("re-checks a dependency hold on the ladder after a restart instead of re-firing every pass", async () => {
    recordRunAuditEventMock.mockClear();
    // A fresh manager stands in for an engine restart: every in-memory memo is empty and only the durable
    // row remains. Its `updatedAt` is when the previous pass stamped the deferral, and that stamp has now
    // expired, so the row is due again — 30 minutes were already spent waiting.
    const stampedAt = Date.now() - (THIRTY_MINUTES + GRACE_EXCEEDED);
    const { manager, transitions, logged } = harness([workItem({
      blockedReason: `${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`,
      updatedAt: new Date(stampedAt).toISOString(),
      retryAfter: new Date(stampedAt + THIRTY_MINUTES).toISOString(),
    })], { blockedBy: "RUFU-196" });
    const before = Date.now();

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);

    const stamped = new Date(String(transitions[0]?.patch.retryAfter)).getTime();
    expect(stamped - before).toBeGreaterThanOrEqual(TWO_HOURS - FIVE_MINUTES);
    expect(stamped - before).toBeLessThanOrEqual(TWO_HOURS + FIVE_MINUTES);
    // Nothing new for the card: the sentence was already written when the condition was first seen.
    expect(logged).toEqual([]);
  });

  it("announces and records a sustained unclaimable hold once, not once per pass", async () => {
    recordRunAuditEventMock.mockClear();
    const held = workItem({ blockedReason: null });
    const { manager, transitions, logged, nextPass } = harness([held]);

    // Pass 1: an unknown reason stays recoverable, so this is a genuine reclaim with one card-history line.
    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(1);
    expect(transitions[0]?.state).toBe("runnable");
    expect(transitions[0]?.patch).toMatchObject({ blockedReason: null, retryAfter: null });
    expect(logged).toEqual([expect.stringContaining("workflow continuation re-queued")]);
    expect(recordRunAuditEventMock).toHaveBeenCalledTimes(1);

    // Pass 2: the node parked the row again for the same reason. The sweep may act, but it must not repeat
    // either announcement — the row is deferred on the ladder instead.
    transitions.length = 0;
    nextPass([workItem({ blockedReason: null })]);
    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);
    expect(transitions[0]?.state).toBe("held");
    expect(logged).toHaveLength(1);

    // Pass 3: due again on the ladder, same condition — still exactly one no-action row for it.
    transitions.length = 0;
    nextPass([workItem({ blockedReason: null })]);
    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);
    expect(recordRunAuditEventMock).toHaveBeenCalledTimes(2);
    expect(recordRunAuditEventMock.mock.calls.map((call) => call[0]?.type)).toEqual([
      "workflowWorkItem:reconcile-stranded-requeued",
      "workflowWorkItem:reconcile-stranded-no-action",
    ]);
    expect(logged).toHaveLength(1);
  });

  it("re-queues a deferred row whose wait has genuinely cleared, clearing the deferral stamp", async () => {
    recordRunAuditEventMock.mockClear();
    // A deferral is not a freeze: the dependency is gone, so the row must become claimable NOW rather than
    // wait out a `retryAfter` this sweep stamped for a condition that no longer exists.
    const { manager, transitions, logged } = harness([workItem({
      blockedReason: `${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196`,
      retryAfter: new Date(Date.now() + TWO_HOURS).toISOString(),
    })]);

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(1);

    expect(transitions[0]?.state).toBe("runnable");
    expect(transitions[0]?.patch).toMatchObject({ retryAfter: null, expectedState: "held" });
    expect(logged.join(" ")).toContain("stale-dependency-hold");
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "workflowWorkItem:reconcile-stranded-requeued",
      metadata: expect.objectContaining({ reason: "stale-dependency-hold" }),
    }));
  });

  it("still retires a held row whose task can never run it again, whatever the reason", async () => {
    recordRunAuditEventMock.mockClear();
    // Reason routing sits below retirement on purpose: a soft-deleted task's principal hold is not a wait
    // with a future, and this is the residue that accumulated for a month before the sweep existed.
    const { manager, transitions } = harness(
      [workItem({ blockedReason: "workflow-role-pool-exhausted:executor" })],
      { column: "archived", deletedAt: staleFrom(1) },
    );

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(1);

    expect(transitions[0]?.state).toBe("cancelled");
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "workflowWorkItem:reconcile-stranded-retired",
    }));
  });

  it("declares every stranded-reclaim event type it emits", () => {
    // RUFU-263's own lesson: this sweep's `-requeued` and `-retired` literals shipped cast into the event
    // type instead of declared in it, so an event row could be written that no schema lists, and nothing
    // failed until someone queried for it. The stranded family is small and owned here, so it stays honest.
    const declared = readFileSync(new URL("../util/run-audit.ts", import.meta.url), "utf8");
    const unionStart = declared.indexOf("export type DatabaseMutationType");
    expect(unionStart).toBeGreaterThan(-1);
    const declaredNames = new Set(
      (declared.slice(unionStart).match(/"([a-zA-Z]+:[a-zA-Z0-9:_-]+)"/g) ?? []).map((raw) => raw.slice(1, -1)),
    );
    const emitted = readFileSync(new URL("../self-healing.ts", import.meta.url), "utf8");
    const strandedEvents = new Set(
      (emitted.match(/"workflowWorkItem:reconcile-stranded[a-z0-9-]*"/g) ?? []).map((raw) => raw.slice(1, -1)),
    );
    expect(strandedEvents.size).toBeGreaterThan(0);
    for (const event of strandedEvents) expect(declaredNames.has(event), event).toBe(true);
  });

  it("makes no autonomous writes while the engine is paused, held reason or not", async () => {
    recordRunAuditEventMock.mockClear();
    const { manager, transitions, logged } = harness(
      [workItem({ blockedReason: `${DEPENDENCY_HOLD_REASON_PREFIX}RUFU-196` })],
      { blockedBy: "RUFU-196" },
      {},
    );
    (manager as unknown as { store: TaskStore }).store.getSettings = vi.fn(async () => ({
      globalPause: true, enginePaused: true,
    } as Settings));

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);

    expect(transitions).toEqual([]);
    expect(logged).toEqual([]);
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
  });
});

/* ── Owner hand-off: what suppression must never break ─────────────────────── */

/*
FNXC:StrandedContinuationReclaim 2026-09-22-16:03 (RUFU-263):
Every `action: "none"` the classifier returns is a promise that SOMEONE ELSE will still act on the row, so
each suppression is answered here by driving the real owner over the very same row:

  - `file-scope:<blockerId>`                → `releaseFileScopeWaitingContinuations` (event-driven, per-task listing)
  - `workflow-human-merge-approval*`        → `releaseHumanMergeApprovalHolds` (due-gated `held` listing)
  - `workflow-principal-*` (planning lane)  → `reconcilePrincipalHeldPlanningContinuations` (FN-8923), which
    restores the `needs-replan` signal triage discovers on; off the planning lane the same family is re-taken
    by the store's own claim predicate, pinned by the family-agreement guard below and by
    `workflow-work-item-cas.pg.test.ts` against the real index.

The load-bearing assertion in each case is `retryAfter === null` after the suppressed pass. The drain and
`releaseHumanMergeApprovalHolds` both list through `listDueWorkflowWorkItems`, which filters `retryAfter <=
now`: a deferral stamped here would hide the row from the only seam allowed to release it, converting
RUFU-263's audit churn into a permanent freeze. The last two cases bound the other direction — an owner that
REFUSES must not leave the row stranded either.
*/

/** The planning lane FN-8592 and FN-8923 both gate on: a hold column carrying a pre-release Plan Review node. */
const planningLaneIr = {
  version: "v2", name: "owner-routing-test", columns: [
    { id: "holding-area", name: "Holding", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-review", name: "Reviewing", traits: [{ trait: "review" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "holding-area" },
    { id: "plan-review", kind: "optional-group", column: "holding-area", config: { defaultOn: true, template: { nodes: [{ id: "reviewer", kind: "prompt", config: { prompt: "Review the plan" } }], edges: [] } } },
  ],
  edges: [{ from: "start", to: "plan-review" }],
} as unknown as WorkflowIr;

/** FN-514's durable decision identity, in the owner's own fixture vocabulary. */
const MERGE_CANDIDATE = {
  lockGeneration: 1,
  workflowSignature: "builtin:coding@7",
  reviewEpisodeId: "2026-09-22T10:00:00.000Z",
  contentSignature: "singular:fp:abc",
  targetSignature: "merge:.@origin:fusion/RUFU-263->main",
};
const HUMAN_ARMED: HumanMergeApprovalState = { enabled: true, generation: 1 };
const HUMAN_DECIDED: HumanMergeApprovalState = {
  enabled: true,
  generation: 1,
  decision: {
    requestId: "r-263",
    action: "merge",
    deliveryAction: "merge",
    decidedBy: "dashboard-operator",
    decidedAt: "2026-09-22T11:00:00.000Z",
    candidate: MERGE_CANDIDATE,
    receipt: { state: "pending", at: "2026-09-22T11:00:00.000Z" },
  },
};

/**
 * Mutable-row harness: `transitionWorkflowWorkItem` is CAS-faithful (honours `expectedState` /
 * `expectedLeaseOwner` and mutates the row it returns) and `listDueWorkflowWorkItems` applies the real
 * store's due-gate (`states`/`kinds` filter, expired lease, `retryAfter <= now`). Without both, a deferral
 * that hid a row from its owner would still look like a pass.
 */
function handoffHarness(
  rows: WorkflowWorkItem[],
  taskOverrides: Partial<Task> = {},
  settings: Partial<Settings> = {},
  /** Extra task rows resolvable by id — RUFU-285 needs them to stand as the live file-scope blocker. */
  holders: Task[] = [],
) {
  const task = {
    id: "RUFU-263", title: "Bound the stranded-continuation sweep", description: "", column: "todo",
    dependencies: [], steps: [], currentStep: 0, log: [], workflowStepResults: [],
    createdAt: staleFrom(GRACE_EXCEEDED), updatedAt: staleFrom(GRACE_EXCEEDED),
    ...taskOverrides,
  } as unknown as Task;
  const transitions: Array<{ id: string; state: string; patch: Record<string, unknown> }> = [];
  const logged: string[] = [];
  const seeded: unknown[] = [];
  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, autoMerge: true, ...settings } as Settings)),
    listDueWorkflowWorkItems: vi.fn(async (args: { now?: string; states?: string[]; kinds?: string[] } = {}) => {
      const nowMs = args.now ? Date.parse(args.now) : Date.now();
      return rows
        .filter((row) => (!args.states || args.states.includes(row.state))
          && (!args.kinds || args.kinds.includes(row.kind))
          && (!row.leaseExpiresAt || Date.parse(row.leaseExpiresAt) <= nowMs)
          && (!row.retryAfter || Date.parse(row.retryAfter) <= nowMs))
        .map((row) => ({ ...row }));
    }),
    listTasks: vi.fn(async () => [{ ...task }]),
    getTask: vi.fn(async (id: string) => (
      id === task.id ? task : holders.find((holder) => holder.id === id)
    )),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    listWorkflowWorkItemsForTask: vi.fn(async (taskId: string) =>
      (taskId === task.id ? rows : []).map((row) => ({ ...row }))),
    transitionWorkflowWorkItem: vi.fn(async (id: string, state: string, patch: Record<string, unknown> = {}) => {
      transitions.push({ id, state, patch });
      const row = rows.find((entry) => entry.id === id);
      if (!row) return null as unknown as WorkflowWorkItem;
      if (patch.expectedState !== undefined && row.state !== patch.expectedState) return { ...row };
      if (patch.expectedLeaseOwner !== undefined && row.leaseOwner !== patch.expectedLeaseOwner) return { ...row };
      const applied = { ...patch };
      delete applied.expectedState;
      delete applied.expectedLeaseOwner;
      Object.assign(row, applied, { state, updatedAt: new Date().toISOString() });
      return { ...row };
    }),
    seedStrandedPlanReviewContinuation: vi.fn(async (input: unknown) => { seeded.push(input); return { seeded: true, workItemId: "seeded-263" }; }),
    replaceActiveTaskWorkflowContinuation: vi.fn(async (input: unknown) => { seeded.push(input); return { id: "seeded-263" }; }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
    logEntry: vi.fn(async (_id: string, message: string) => { logged.push(message); }),
    getRootDir: vi.fn(() => "/repo"),
    getTasksDir: vi.fn(() => ""),
  } as unknown as TaskStore;
  resolveTaskLifecycleColumnsMock.mockResolvedValue({ complete: "done" });
  return {
    store, task, rows, transitions, logged, seeded,
    manager: new SelfHealingManager(store, { rootDir: "/repo" }),
  };
}

describe("hold owners still recover the rows this sweep leaves alone", () => {
  it("suppresses a file-scope wait and its release owner still releases it when the blocker clears", async () => {
    const blockerId = "RUFU-128";
    const row = workItem({ blockedReason: `${FILE_SCOPE_HOLD_REASON_PREFIX}${blockerId}` });
    const { store, task, manager, transitions } = handoffHarness([row], { overlapBlockedBy: blockerId });

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);
    expect(transitions).toEqual([]);
    expect(row.state).toBe("held");
    // The owner lists this row per task, but the drain lists it by due time: a stamp would delay the resume.
    expect(row.retryAfter).toBeNull();

    // The blocker's lease cleared, so the event carrying its release is allowed to arrive.
    delete task.overlapBlockedBy;
    await expect(releaseFileScopeWaitingContinuations(store, [{ taskId: task.id, blockerId }]))
      .resolves.toEqual([row.id]);
    expect(row.state).toBe("runnable");
    expect(row.blockedReason).toBeNull();

    // A released row is an ordinary claimable continuation — the sweep must not mistake it for a stranded one.
    transitions.length = 0;
    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);
    expect(transitions).toEqual([]);
  });

  it("writes nothing while an FN-514 delivery wait is real, and the owner releases the moment its decision lands", async () => {
    const parkedReason = buildHumanMergeHoldMarker(
      "-pending",
      describeHumanMergeHoldSignature({ humanMergeApproval: HUMAN_ARMED } as unknown as Task),
    );
    const row = workItem({ blockedReason: parkedReason });
    const { store, task, manager, transitions } = handoffHarness([row], {
      column: "in-review",
      humanMergeApproval: HUMAN_ARMED,
    });

    // The operator has not acted: neither seam writes, so a real wait costs zero rows per pass. That is the
    // whole task — RUFU-220 burned 782 identical recovery lines on a card nobody could yet run.
    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);
    await expect(releaseHumanMergeApprovalHolds(store)).resolves.toEqual([]);
    expect(transitions).toEqual([]);
    expect(row.state).toBe("held");
    // This owner reads through the due-gated `held` listing, so a deferral here would suppress the OWNER.
    expect(row.retryAfter).toBeNull();

    task.humanMergeApproval = HUMAN_DECIDED;
    await expect(releaseHumanMergeApprovalHolds(store)).resolves.toEqual([row.id]);
    expect(row.state).toBe("runnable");
    expect(row.blockedReason).toBeNull();
  });

  it("suppresses a principal planning hold whose owners are FN-8923 and the store's claim predicate", async () => {
    recordRunAuditEventMock.mockClear();
    const row = workItem({
      nodeId: "plan-review",
      workflowRole: "triage",
      blockedReason: "workflow-principal-role-pool-exhausted:triage",
    });
    resolveWorkflowIrForTaskMock.mockResolvedValue(planningLaneIr);
    const { manager, task, seeded, transitions } = handoffHarness([row], {
      column: "holding-area",
      status: null,
      columnMovedAt: staleFrom(GRACE_EXCEEDED),
    });

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);
    expect(transitions).toEqual([]);
    // The scheduler claims through the same due-gate, so a suppressed row must stay due.
    expect(row.retryAfter).toBeNull();

    // FN-8592 is the OTHER planning owner and it must decline: its case is a card with no continuation at all.
    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);
    expect(seeded).toEqual([]);
    // Control that the decline above is the row's doing and not a harness gap: the same input with the row
    // removed clears FN-8592's active-continuation veto, so the held row is exactly why this card is not its
    // case. Its positive cases stay owned by self-healing-stranded-hold-continuation.test.ts.
    const fn8592Input = (continuations: WorkflowWorkItem[]) => ({
      task,
      columnFlags: { hold: true },
      ir: planningLaneIr,
      continuations,
      stepResults: task.workflowStepResults,
      effectiveSettings: { autoMerge: true },
      enginePaused: false,
      promptContent: "# Bound the stranded-continuation sweep\n\nSteps and acceptance criteria.",
      live: false,
      stalenessMs: GRACE_EXCEEDED,
      graceMs: FIVE_MINUTES,
      now: Date.now(),
    });
    expect(evaluateStrandedHoldContinuation(fn8592Input([row]))).toMatchObject({
      candidate: false, reason: "active-continuation",
    });
    expect(evaluateStrandedHoldContinuation(fn8592Input([])).reason).not.toBe("active-continuation");

    // FN-8923 is the owner: it restores the planning signal triage's hold-column discovery keys on.
    await expect(manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(1);
    expect(task.status).toBe("needs-replan");
    // The row stays the durable evidence of the wait — FN-8923 repairs the signal, not the row.
    expect(row.state).toBe("held");
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:reconcile-principal-held-planning",
      metadata: expect.objectContaining({
        taskId: task.id, column: "holding-area", nodeId: "plan-review",
        blockedReason: "workflow-principal-role-pool-exhausted:triage",
      }),
    }));
  });

  it("recovers a file-scope hold the release owner refuses, so suppression cannot become a freeze", async () => {
    // The release owner refuses any task with an unmet `blockedBy`, and it only ever runs from the blocker's
    // own completion event. A lost release (restart, cancelled blocker) therefore leaves a `file-scope:` row
    // nothing else re-drives: this sweep is the backstop, and that is why an orphan is a reclaim.
    const row = workItem({ blockedReason: `${FILE_SCOPE_HOLD_REASON_PREFIX}RUFU-128` });
    const { store, manager } = handoffHarness([row], { blockedBy: "RUFU-777" });

    await expect(releaseFileScopeWaitingContinuations(store, [{ taskId: row.taskId, blockerId: "RUFU-128" }]))
      .resolves.toEqual([]);
    expect(row.state).toBe("held");

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(1);
    expect(row.state).toBe("runnable");
    // A re-queue must also clear the deferral stamp, or the row stays unclaimable anyway.
    expect(row.retryAfter).toBeNull();
  });

  it("suppresses exactly the families another seam owns, in agreement with those seams", () => {
    // The principal families are the ones this sweep may only suppress, and the permission for that is the
    // store's OWN claim predicate. Read the families out of that predicate so widening it without updating
    // the classifier (churn returns) — or narrowing it (rows freeze forever) — fails here, not in production.
    const claimSrc = readFileSync(
      new URL("../../../core/src/task-store/workflow-workitems-ops-2.ts", import.meta.url), "utf8",
    );
    const claimFamilies = new Set(
      Array.from(claimSrc.matchAll(/blockedReason,\s*"([a-z0-9-]+)-%"/g), (match) => `${match[1]}-`),
    );
    expect(claimFamilies.size).toBeGreaterThan(0);
    expect(new Set(CLAIMABLE_HOLD_REASON_PREFIXES)).toEqual(claimFamilies);

    // The human-merge family must agree with the predicate the release owner itself uses.
    for (const reason of [
      `${HUMAN_MERGE_APPROVAL_HOLD_MARKER}#${describeHumanMergeHoldSignature({ humanMergeApproval: HUMAN_ARMED } as unknown as Task)}`,
      buildHumanMergeHoldMarker("-pending", "sig-from-an-earlier-sha"),
    ]) {
      expect(isHumanMergeAdmissionHold(reason), reason).toBe(true);
      expect(evaluateStrandedContinuationReclaim(heldInput(reason)), reason).toMatchObject({
        action: "none", reason: "human-merge-approval-hold",
      });
    }
  });
});

/* ── RUFU-285: the caller converges the loop instead of re-firing it ─────── */

/*
FNXC:StrandedContinuationReclaim 2026-09-26-03:05 (RUFU-285):
Symptom-verification suite for the RUFU-254 loop. The staged card is the real shape: `todo`/`queued` with
`blockedBy: null`, `overlapBlockedBy` naming a live card, and the matching `queuedLogEpisodeSignature`,
against a `held` `plan-review` row that carries no owned reason. `handoffHarness` is the CAS-faithful fake —
it applies the patch, honours `expectedState`/`expectedLeaseOwner`, and due-gates the listing exactly like
`listDueWorkflowWorkItems` — so a stamped deferral disappears from the next pass on its own, which is what
makes the passes below a reproduction of the loop rather than a mock of the fix.
*/
describe("reconcileStrandedWorkflowContinuations — an overlap-evidenced hold converges instead of looping", () => {
  const BLOCKED_ID = "RUFU-254";
  const HOLDER_ID = "RUFU-257";
  const CONVERGED = `${FILE_SCOPE_HOLD_REASON_PREFIX}${HOLDER_ID}`;

  const holder = (overrides: Partial<Task> = {}) => ({
    id: HOLDER_ID, title: "Structural CI guard", description: "", column: "in-progress",
    dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: staleFrom(GRACE_EXCEEDED), updatedAt: staleFrom(GRACE_EXCEEDED),
    ...overrides,
  } as unknown as Task);

  /** The blocked card exactly as the loop left it: queued on another live card's file-scope lease. */
  const overlapBlocked = () => ({
    id: BLOCKED_ID, status: "queued", blockedBy: null,
    overlapBlockedBy: HOLDER_ID, queuedLogEpisodeSignature: CONVERGED,
  });

  const heldRow = (overrides: Partial<WorkflowWorkItem> = {}) => workItem({
    id: "wi-254", taskId: BLOCKED_ID, nodeId: "plan-review", blockedReason: null,
    leaseOwner: null, retryAfter: null, ...overrides,
  });

  /**
   * Age the converged row and expire its stamp, which is the state a ladder rung actually presents: the write
   * set `updatedAt`, so without rolling it back the pass would stop at `too-fresh` and never re-read the task
   * evidence the acceptance depends on.
   */
  const agedAndDue = (row: WorkflowWorkItem) => {
    row.updatedAt = staleFrom(GRACE_EXCEEDED);
    row.retryAfter = staleFrom(FIVE_MINUTES);
  };

  it("converges on the first pass and writes nothing on the passes after", async () => {
    recordRunAuditEventMock.mockClear();
    const row = heldRow();
    const { manager, transitions, logged } = handoffHarness([row], overlapBlocked(), {}, [holder()]);

    // Pass 1: the capacity-`onSuspend` shape — a held row whose reason proves nothing.
    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      id: row.id, state: "held",
      patch: { expectedState: "held", expectedLeaseOwner: null, blockedReason: CONVERGED },
    });
    // One write carries both halves of the durable pair: the owned reason and a ladder stamp. The card stays
    // parked instead of waking the planner lane with a real model.
    expect(row.state).toBe("held");
    expect(row.blockedReason).toBe(CONVERGED);
    expect(Date.parse(String(row.retryAfter))).toBeGreaterThan(Date.now());
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "workflowWorkItem:reconcile-stranded-no-action",
      metadata: expect.objectContaining({
        taskId: BLOCKED_ID, nodeId: "plan-review", reason: "file-scope-wait-converged",
      }),
    }));

    // Passes 2..N: the row the sweep wrote IS the table's state, and it is now the shipped `file-scope-hold`
    // suppression case. Expiring the stamp makes each pass a real due evaluation rather than a skipped gap.
    for (let pass = 2; pass <= 4; pass += 1) {
      transitions.length = 0;
      recordRunAuditEventMock.mockClear();
      agedAndDue(row);

      await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);

      expect(transitions, `pass ${pass}`).toEqual([]);
      expect(row.state, `pass ${pass}`).toBe("held");
      expect(row.blockedReason, `pass ${pass}`).toBe(CONVERGED);
    }

    // The measured symptom was 402 `[recovery]` lines over 6 days (72–85 per day) for this exact loop. Across
    // four due passes of the staged card the card history gained nothing and nothing was re-queued.
    expect(logged).toEqual([]);
  });

  it("re-converges a row whose writer keeps replacing the reason, and still never re-queues or announces", async () => {
    recordRunAuditEventMock.mockClear();
    const { rows, manager, transitions, logged } = handoffHarness([heldRow()], overlapBlocked(), {}, [holder()]);
    const oscillating = [null, "plan-review-close-capacity", ""];

    for (let pass = 1; pass <= 3; pass += 1) {
      transitions.length = 0;
      // The real re-holding writer replaces the row through `replaceActiveTaskWorkflowContinuation`: fresh id,
      // `retryAfter` reset to null. That is what defeats the process memo and the ladder both, so convergence
      // has to survive it — one owned-reason write per pass, never a re-queue.
      rows.splice(0, rows.length, heldRow({ id: `wi-254-pass-${pass}`, blockedReason: oscillating[pass - 1] }));

      await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);

      expect(transitions, `pass ${pass}`).toHaveLength(1);
      expect(transitions[0]!.state, `pass ${pass}`).toBe("held");
      expect(transitions[0]!.patch.blockedReason, `pass ${pass}`).toBe(CONVERGED);
    }

    expect(logged).toEqual([]);
  });

  it("keeps the wedge-class first-sight re-queue for the identical card with no blocker named", async () => {
    recordRunAuditEventMock.mockClear();
    // (a) The promise RUFU-263 kept, restated on the loop's own fixture so the two dispositions are provably
    // separated by the durable overlap evidence and not by the shape of the row.
    const { manager, transitions, logged } = handoffHarness([heldRow()], {
      id: BLOCKED_ID, status: "queued", blockedBy: null,
    }, {}, [holder()]);

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(1);

    expect(transitions[0]).toMatchObject({ state: "runnable", patch: { blockedReason: null, retryAfter: null } });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("workflow continuation re-queued");
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "workflowWorkItem:reconcile-stranded-requeued",
      metadata: expect.objectContaining({ reason: "unclaimable-hold" }),
    }));
  });

  it("keeps the first-sight re-queue for every way the holder can fail to be live", async () => {
    const deadHolders: Array<[string, Task[]]> = [
      ["terminal column", [holder({ column: "done" })]],
      ["soft-deleted", [holder({ deletedAt: staleFrom(FIVE_MINUTES) })]],
      ["unresolvable", []],
    ];
    for (const [label, holders] of deadHolders) {
      recordRunAuditEventMock.mockClear();
      const { manager, transitions, logged } = handoffHarness([heldRow()], overlapBlocked(), {}, holders);

      await expect(manager.reconcileStrandedWorkflowContinuations(), label).resolves.toBe(1);

      expect(transitions[0]?.state, label).toBe("runnable");
      expect(logged, label).toHaveLength(1);
      expect(logged[0], label).toContain("workflow continuation re-queued");
    }
  });

  it("spends the holder lookup only on a row that actually needs the proof", async () => {
    const row = heldRow({ blockedReason: CONVERGED });
    const { store, manager, transitions } = handoffHarness([row], overlapBlocked(), {}, [holder()]);

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(0);

    // The reason already names the task's blocker, so the shipped suppression answers without a second
    // `getTask` — a holder read for every owned-family row would tax every maintenance pass.
    expect(transitions).toEqual([]);
    const lookedUp = (store.getTask as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(lookedUp).not.toContain(HOLDER_ID);
  });

  it("hands the converged row to the release owner, which clears the deferral stamp on wake", async () => {
    recordRunAuditEventMock.mockClear();
    const row = heldRow();
    const { store, task, manager, logged } = handoffHarness([row], overlapBlocked(), {}, [holder()]);

    await manager.reconcileStrandedWorkflowContinuations();
    expect(row.blockedReason).toBe(CONVERGED);
    expect(row.retryAfter).not.toBeNull();

    // (b) Freeze-safety: the converged shape is exactly what `releaseFileScopeWaitingContinuations` matches,
    // and its CAS writes `retryAfter: null`, so a ladder stamp can never delay the resume.
    delete task.overlapBlockedBy;
    delete task.queuedLogEpisodeSignature;
    await expect(releaseFileScopeWaitingContinuations(store, [{ taskId: BLOCKED_ID, blockerId: HOLDER_ID }]))
      .resolves.toEqual([row.id]);

    expect(row.state).toBe("runnable");
    expect(row.retryAfter).toBeNull();
    expect(row.blockedReason).toBeNull();
    expect(logged).toEqual([]);
  });

  it("re-queues a converged row whose task-level blocker moved to another card", async () => {
    recordRunAuditEventMock.mockClear();
    const row = heldRow();
    const { store, task, manager, transitions, logged } = handoffHarness([row], overlapBlocked(), {}, [holder()]);
    await manager.reconcileStrandedWorkflowContinuations();
    expect(row.blockedReason).toBe(CONVERGED);

    // (c) Drift escape hatch: the lease wait ended but no release event reached this row — the blocker id
    // changed underneath it. This orphan re-queue is what keeps convergence from becoming a freeze.
    transitions.length = 0;
    recordRunAuditEventMock.mockClear();
    await store.updateTask(BLOCKED_ID, { overlapBlockedBy: "RUFU-999" });
    agedAndDue(row);

    await expect(manager.reconcileStrandedWorkflowContinuations()).resolves.toBe(1);

    expect(transitions[0]).toMatchObject({ state: "runnable", patch: { retryAfter: null } });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("stale-file-scope-hold");
  });
});
