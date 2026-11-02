import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import type {
  InReviewStallSignal,
  StalePausedReviewSignal,
  StalledReviewSignal,
  TaskExternalBlock,
} from "@fusion/core";

import {
  PAUSE_REASON_LABELS,
  resolveStallReason,
  isPausedFamilyCode,
  stallReasonVisibleOnFace,
  type StallContext,
  type StallReason,
  type StallReasonCode,
  type StallSubject,
} from "../stallReason";
import { getInReviewStallCopy } from "../inReviewStallCopy";
import { getStalePausedReviewCopy } from "../stalePausedReviewCopy";

/*
FNXC:StallReason 2026-09-01-17:48 (RUFU-175):
These tests assert the resolver's CONTRACT the way the surrounding copy tests do — by the recorded
(t("key", "defaultString")) pairs, NOT by the rendered string. String equality would only prove the
English default happens to match; the (key, default) pair is what proves the copy reaches the
translator through the intended key. The stub below records each call and still interpolates
`{{token}}` so parameterized copy (the blocking task id, an unknown pause reason) can be asserted to
carry its runtime data.
*/

type RecordedCall = { key: string; fallback: string; resolved: string };

function makeT() {
  const calls: RecordedCall[] = [];
  const t = ((key: string, arg?: unknown, opts?: unknown) => {
    let fallback: string;
    let interpolation: Record<string, unknown> | undefined;
    if (typeof arg === "string") {
      fallback = arg;
      interpolation = (opts as Record<string, unknown> | undefined) ?? undefined;
    } else if (arg && typeof arg === "object") {
      interpolation = arg as Record<string, unknown>;
      fallback = typeof (arg as { defaultValue?: unknown }).defaultValue === "string"
        ? ((arg as { defaultValue: string }).defaultValue)
        : key;
    } else {
      fallback = key;
    }
    let resolved = fallback;
    if (interpolation) {
      for (const [name, value] of Object.entries(interpolation)) {
        resolved = resolved.split(`{{${name}}}`).join(String(value));
      }
    }
    calls.push({ key, fallback, resolved });
    return resolved;
  }) as unknown as TFunction<"app">;
  const call = (key: string) => calls.find((c) => c.key === key);
  const keys = () => calls.map((c) => c.key);
  return { t, calls, call, keys };
}

const ISO_T = "2026-01-01T00:00:00.000Z";
const T_MS = Date.parse(ISO_T);

function subject(over: Partial<StallSubject> = {}): StallSubject {
  return { column: "in-progress", updatedAt: ISO_T, ...over };
}

function fullExternalBlock(): TaskExternalBlock {
  return {
    origin: "model-provider",
    code: "quota",
    message: "provider quota exhausted",
    source: "session-failure",
    blockedAt: ISO_T,
    resume: { column: "in-progress", currentStep: 2 },
  };
}

const stalledReview: StalledReviewSignal = {
  reason: "review re-enqueued 6 times without progress",
  heuristic: "reenqueue-churn",
  matchCount: 6,
  firstMatchAt: ISO_T,
  lastMatchAt: ISO_T,
};

/*
FNXC:StallReason 2026-09-02-21:49 (RUFU-177):
One fixture per client-side chain code, hoisted so two different invariants read from the SAME factory:
"every emitted code asks the translator for at least one key" and "a present server field outranks every
client code". A per-describe copy would let the second test drift from the first and quietly stop covering
a branch that a later precedence change added.
The two verbatim review-lane delegates (in-review-stall, stale-paused-review) intentionally reuse their
English copy modules unchanged (a pre-existing localization debt, not new copy), so they are excluded here
and asserted equal to their module in the delegation describe above instead.
*/
interface ClientFixture {
  subject: StallSubject;
  ctx?: Partial<StallContext>;
}

const clientChainFixtures: Record<string, () => ClientFixture> = {
  externalBlock: () => ({ subject: subject({ status: "blocked", externalBlock: fullExternalBlock() }) }),
  duplicateDecision: () => ({ subject: subject({ paused: true, pausedReason: "duplicate-decision-required", sourceMetadata: { duplicateSource: "a" } }) }),
  agentPaused: () => ({ subject: subject({ paused: true, pausedByAgentId: "a" }) }),
  userPaused: () => ({ subject: subject({ paused: true, userPaused: true }) }),
  enginePaused: () => ({ subject: subject({ paused: true, pausedReason: "budget-exhausted" }) }),
  agentApproval: () => ({ subject: subject({ status: "in-progress" }), ctx: { agent: { pendingApprovalCount: 1 } } }),
  wedge: () => ({ subject: subject({ wedgeNotification: { reasonKey: "k", episodeId: "e", status: "active", transitionedAt: ISO_T } }) }),
  dependencyBlock: () => ({ subject: subject({ blockedBy: "FN-1" }) }),
  overlapBlock: () => ({ subject: subject({ overlapBlockedBy: "FN-2" }) }),
  mergeBlocker: () => ({ subject: subject(), ctx: { mergeBlockerReason: "m" } }),
  completionBlocker: () => ({ subject: subject(), ctx: { completionBlockerReason: "c" } }),
  stalledReview: () => ({ subject: subject({ stalledReview }) }),
  failed: () => ({ subject: subject({ status: "failed", error: "e" }) }),
  queued: () => ({ subject: subject({ queuedReason: "q" }) }),
};

describe("resolveStallReason — flow and precedence", () => {
  it("returns undefined for a flowing card and never asks the translator for stall copy", () => {
    const { t, calls } = makeT();
    const result = resolveStallReason(subject({ status: "in-progress" }), { t });
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("does NOT read a plain queued card as a stall (symptom a): no queuedReason -> undefined", () => {
    const { t } = makeT();
    expect(resolveStallReason(subject({ status: "todo", column: "todo" }), { t })).toBeUndefined();
  });

  it("lets an external block outrank every other concurrent signal", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(
      subject({
        status: "blocked",
        externalBlock: fullExternalBlock(),
        // Everything else a lower-precedence classifier would also claim:
        paused: true,
        userPaused: true,
        pausedByAgentId: "agent-1",
        blockedBy: "FN-9",
        stalledReview,
      }),
      { t, mergeBlockerReason: "would-lose", completionBlockerReason: "would-lose-too" },
    );
    expect(result?.code).toBe("external-block");
    expect(result?.resumeTo).toBe("in-progress");
    expect(call("stall.external-block.badgeLabel")).toMatchObject({ fallback: "Blocked" });
  });

  it("orders the paused family agent-paused > user-paused > engine-paused", () => {
    const { t } = makeT();
    expect(resolveStallReason(subject({ paused: true, userPaused: true, pausedByAgentId: "a" }), { t })?.code).toBe("agent-paused");
    expect(resolveStallReason(subject({ paused: true, userPaused: true }), { t })?.code).toBe("user-paused");
    expect(resolveStallReason(subject({ paused: true }), { t })?.code).toBe("engine-paused");
  });

  /*
  FNXC:StallReason 2026-09-01-17:48 (RUFU-175):
  The dashboard renders `userPaused` as paused even when the engine did not also set `paused` (the
  surfaces' isPaused gate reads `paused || userPaused`). The resolver must agree, or a card the UI shows
  as paused would classify as flowing and answer "why isn't it moving?" with nothing. The badge label
  still resolves through the caller's tasks.paused key with the identical default, so the overlay is
  byte-identical to the pre-resolver inline label.
  */
  it("classifies a userPaused overlay (no engine `paused` flag) as user-paused, byte-identical badge", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ paused: undefined, userPaused: true }), { t });
    expect(result?.code).toBe("user-paused");
    expect(call("tasks.paused")).toMatchObject({ fallback: "paused" });
  });

  it("treats an agent owner with a userPaused overlay as agent-paused (agent wins)", () => {
    const { t } = makeT();
    const result = resolveStallReason(subject({ paused: undefined, userPaused: true, pausedByAgentId: "agent-1" }), { t });
    expect(result?.code).toBe("agent-paused");
  });

  it("reports a pause (not a wedge) when both apply, per precedence", () => {
    const { t } = makeT();
    const result = resolveStallReason(
      subject({
        paused: true,
        wedgeNotification: { reasonKey: "k", episodeId: "e", status: "active", transitionedAt: ISO_T },
      }),
      { t },
    );
    expect(result?.code).toBe("engine-paused");
  });

  it("reports a context blocker ahead of a review-lane signal", () => {
    const { t } = makeT();
    const signal: InReviewStallSignal = { code: "merge-retries-exhausted", reason: "r", observedAt: ISO_T };
    const result = resolveStallReason(subject({ inReviewStall: signal }), { t, mergeBlockerReason: "pre-merge check" });
    expect(result?.code).toBe("merge-blocker");
  });

  it("reports failed ahead of queued but behind every review-lane signal", () => {
    const { t } = makeT();
    expect(resolveStallReason(subject({ status: "failed", error: "boom", queuedReason: "x" }), { t })?.code).toBe("failed");
    const review: StallReason | undefined = resolveStallReason(
      subject({ status: "failed", stalledReview }),
      { t },
    );
    expect(review?.code).toBe("stalled-review");
  });
});

describe("resolveStallReason — pause family (byte-identity via (key, default))", () => {
  it("duplicate-decision reuses tasks.needsUserFeedback with its exact default", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(
      subject({ paused: true, pausedReason: "duplicate-decision-required", sourceMetadata: { duplicateSource: "agent-x" } }),
      { t },
    );
    expect(result?.code).toBe("duplicate-decision");
    expect(call("tasks.needsUserFeedback")).toMatchObject({ fallback: "Needs your decision" });
  });

  it("a duplicate card whose reason string is set but WITHOUT duplicate provenance is NOT duplicate-decision", () => {
    const { t } = makeT();
    // pausedReason set to the duplicate marker but no sourceMetadata marker -> falls through to engine-paused.
    const result = resolveStallReason(subject({ paused: true, pausedReason: "duplicate-decision-required" }), { t });
    expect(result?.code).toBe("engine-paused");
  });

  it("agent-paused reuses tasks.pausedByAgent and the budget key, and carries ageMs from dataAsOfMs", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(
      subject({ paused: true, pausedByAgentId: "agent-1", pausedReason: "budget-exhausted" }),
      { t, dataAsOfMs: T_MS + 5000 },
    );
    expect(result?.code).toBe("agent-paused");
    expect(call("tasks.pausedByAgent")).toMatchObject({ fallback: "paused by agent" });
    expect(call("stall.pausedReason.budget-exhausted.headline")).toMatchObject({ fallback: "Output budget exhausted" });
    expect(result?.ageMs).toBe(5000);
  });

  it("agent-paused honours the pausedBadgeKeys override (ListView keeps listView.pausedByAgent)", () => {
    const { t, call } = makeT();
    resolveStallReason(
      subject({ paused: true, pausedByAgentId: "agent-1" }),
      { t, pausedBadgeKeys: { agentPaused: "listView.pausedByAgent" } },
    );
    // Key is the caller's; the English default stays byte-identical so zh divergence is the only delta.
    expect(call("listView.pausedByAgent")).toMatchObject({ fallback: "paused by agent" });
  });

  it("duplicate-decision honours the pausedBadgeKeys.needsDecision override", () => {
    const { t, call } = makeT();
    resolveStallReason(
      subject({ paused: true, pausedReason: "duplicate-decision-required", sourceMetadata: { nearDuplicateOf: "FN-1" } }),
      { t, pausedBadgeKeys: { needsDecision: "custom.needsDecision" } },
    );
    expect(call("custom.needsDecision")).toMatchObject({ fallback: "Needs your decision" });
  });

  it("user-paused reuses tasks.paused and the plain no-reason headline", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ paused: true, userPaused: true }), { t });
    expect(result?.code).toBe("user-paused");
    expect(call("tasks.paused")).toMatchObject({ fallback: "paused" });
    expect(call("stall.paused.headline")).toMatchObject({ fallback: "This card is paused" });
  });

  it("engine-paused names an enumerated reason (heartbeat-unresponsive)", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ paused: true, pausedReason: "heartbeat-unresponsive" }), { t });
    expect(result?.code).toBe("engine-paused");
    expect(call("stall.pausedReason.heartbeat-unresponsive.headline")).toMatchObject({ fallback: "Heartbeat unresponsive" });
  });

  it("an unenumerated pausedReason falls back to the generic headline that names the raw code", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ paused: true, pausedReason: "some-engine-park-reason" }), { t });
    expect(result?.code).toBe("engine-paused");
    const recorded = call("stall.pausedReason.generic.headline");
    expect(recorded).toBeDefined();
    // The recorded default is the interpolation template; the resolved string must carry the raw code.
    expect(recorded!.resolved).toContain("some-engine-park-reason");
  });

  it("a table-known but unenumerated reason renders its humanized word via the generic template", () => {
    const { t, call } = makeT();
    resolveStallReason(subject({ paused: true, pausedReason: "manual" }), { t });
    expect(call("stall.pausedReason.generic.headline")!.resolved).toContain(PAUSE_REASON_LABELS["manual"]);
  });

  it("isPausedFamilyCode classifies the four pause codes and rejects the rest", () => {
    expect(isPausedFamilyCode("agent-paused")).toBe(true);
    expect(isPausedFamilyCode("user-paused")).toBe(true);
    expect(isPausedFamilyCode("engine-paused")).toBe(true);
    expect(isPausedFamilyCode("duplicate-decision")).toBe(true);
    expect(isPausedFamilyCode("wedge")).toBe(false);
    expect(isPausedFamilyCode("failed")).toBe(false);
  });

  it("PAUSE_REASON_LABELS covers the documented Step-1 inventory", () => {
    for (const code of [
      "error-unrecoverable",
      "error-retry-exhausted",
      "awaiting-approval",
      "heartbeat-model-unavailable",
      "heartbeat-unresponsive",
      "budget-exhausted",
      "migrated-from-terminated",
      "manual",
      "user-requested",
      "testing",
      "duplicate-decision-required",
    ]) {
      expect(PAUSE_REASON_LABELS[code], `label for ${code}`).toBeTruthy();
    }
  });
});

describe("resolveStallReason — reused pause-key defaults are byte-identical", () => {
  it.each([
    ["tasks.pausedByAgent", "paused by agent"],
    ["tasks.paused", "paused"],
    ["tasks.needsUserFeedback", "Needs your decision"],
  ] as const)("records %s with default %j", (key, expectedDefault) => {
    const { t, call } = makeT();
    if (key === "tasks.pausedByAgent") {
      resolveStallReason(subject({ paused: true, pausedByAgentId: "agent-1" }), { t });
    } else if (key === "tasks.paused") {
      resolveStallReason(subject({ paused: true }), { t });
    } else {
      resolveStallReason(
        subject({ paused: true, pausedReason: "duplicate-decision-required", sourceMetadata: { duplicateSource: "a" } }),
        { t },
      );
    }
    expect(call(key)?.fallback).toBe(expectedDefault);
  });
});

describe("resolveStallReason — non-pause codes reach the translator", () => {
  it("agent-approval when the agent has a pending approval", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ status: "in-progress" }), { t, agent: { pendingApprovalCount: 2 } });
    expect(result?.code).toBe("agent-approval");
    expect(call("stall.agent-approval.badgeLabel")).toMatchObject({ fallback: "Awaiting approval" });
  });

  /*
  FNXC:StallReason 2026-09-02-15:52 (RUFU-175):
  The engine's approval gate writes `pauseReason: "awaiting-approval"` on the agent and NO count, while
  `pendingApprovalCount` is a separate API-route enrichment. Both must classify on their own, otherwise a
  board payload that carries only the pause reason reads as flowing while an approval is outstanding.
  */
  it("agent-approval from the agent's pauseReason alone, with no approval count", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(
      subject({ status: "in-progress" }),
      { t, agent: { state: "paused", pauseReason: "awaiting-approval" } },
    );
    expect(result?.code).toBe("agent-approval");
    expect(call("stall.agent-approval.headline")).toMatchObject({
      fallback: "A tool call is waiting for your approval",
    });
  });

  it("a non-approval agent pause reason with no count stays flowing", () => {
    const { t } = makeT();
    const result = resolveStallReason(
      subject({ status: "in-progress" }),
      { t, agent: { state: "paused", pauseReason: "budget-exhausted" } },
    );
    expect(result).toBeUndefined();
  });

  /*
  FNXC:ProviderThrottleIsTransient 2026-09-30-14:58 (RUFU-286):
  A card whose agent is waiting out a provider throttle was the shape an operator read as "stuck, and the
  error text says the model name is wrong". The card must say the wait is rate limiting and that it ends
  by itself. `throttleRetryAt` is the mapper's derived field, so these cases feed exactly what the mapper
  produces — never a raw metadata bag — which is what keeps a second reader of the episode from existing.
  */
  it("agent-rate-limited when the owning agent holds a live throttle cooldown", () => {
    const { t, call } = makeT();
    const retryingAt = new Date(Date.parse("2026-09-30T12:02:00.000Z")).toISOString();
    const result = resolveStallReason(
      subject({ status: "in-progress" }),
      { t, agent: { state: "error", lastError: "429 rate_limit_error (unknown model, no fallback configured)", throttleRetryAt: retryingAt } },
    );

    expect(result?.code).toBe("agent-rate-limited");
    expect(call("stall.agent-rate-limited.badgeLabel")).toMatchObject({ fallback: "Rate limited" });
    expect(result?.description).toContain(retryingAt);
    // The misdiagnosis sentence must not be what the card repeats.
    expect(result?.headline).not.toContain("unknown model");
  });

  it("an exhausted throttle with no retry scheduled leaves the card flowing", () => {
    // Control: the rung keys on a scheduled retry, not on the throttle row being present. An exhausted
    // park has no retry to promise, so inventing this code there would name a recovery that will not come.
    const { t } = makeT();
    const result = resolveStallReason(
      subject({ status: "in-progress" }),
      { t, agent: { state: "paused", pauseReason: "error-retry-exhausted" } },
    );
    expect(result).toBeUndefined();
  });

  it("ranks a card-specific blocker above the agent-wide throttle wait", () => {
    // `throttleRetryAt` comes from the owning AGENT, so it is aggregated across every card that agent
    // owns; a blocker that names THIS card must win, the same lesson the approval rung learned.
    const { t } = makeT();
    const result = resolveStallReason(
      subject({ column: "in-review" }),
      { t, mergeBlockerReason: "pre-merge check 'lint' failed", agent: { state: "error", throttleRetryAt: new Date(Date.parse(ISO_T) + 120_000).toISOString() } },
    );
    expect(result?.code).toBe("merge-blocker");
  });

  /*
  FNXC:StallReason 2026-09-03-01:01 (RUFU-177):
  RUFU-177's consumer wiring made this branch reachable from the board, and its ranking turned out to be
  load-bearing: `pendingApprovalCount` is a per-ACTOR aggregate (`getPendingCountsByActor`), so an approval
  pending on card X is reported on every card that agent owns. Ranked ahead of the card-specific blockers it
  therefore erased THEIR only visible affordance — `agent-approval` renders no face chip and no detail banner
  — which is the silent-stall state this whole feature exists to cure (a `todo` card waiting on FN-9 went
  blank because its agent was parked on another card's approval). These cases pin the invariant for BOTH
  approval signals and every face-visible card cause, while keeping the two rankings that are correct: a
  pause written on THIS card outranks the agent's wait, a review-lane code does not, and the server field
  outranks everything.
  */
  describe("an agent approval wait never masks a card-specific blocker", () => {
    const approvalSignals: Array<[string, StallContext["agent"]]> = [
      ["the read-path pendingApprovalCount", { state: "running", pendingApprovalCount: 2 }],
      ["the engine approval park", { state: "paused", pauseReason: "awaiting-approval" }],
    ];
    const cardCauses: Array<[string, () => StallSubject, StallContext, StallReasonCode]> = [
      ["an unmet dependency edge", () => subject({ column: "todo", status: "todo", blockedBy: "FN-9" }), {}, "dependency-block"],
      [
        "an active wedge",
        () => subject({ wedgeNotification: { reasonKey: "k", episodeId: "e", status: "active", transitionedAt: ISO_T } }),
        {},
        "wedge",
      ],
      ["an overlap edge", () => subject({ overlapBlockedBy: "FN-3" }), {}, "overlap-block"],
      ["a merge blocker", () => subject({ column: "in-review" }), { mergeBlockerReason: "pre-merge check 'lint' failed" }, "merge-blocker"],
      ["a completion blocker", () => subject({ column: "in-review" }), { completionBlockerReason: "awaiting validation" }, "completion-blocker"],
    ];

    for (const [signalName, agent] of approvalSignals) {
      for (const [causeName, makeCauseSubject, extraCtx, expected] of cardCauses) {
        it(`${signalName} does not mask ${causeName}`, () => {
          const { t } = makeT();
          const result = resolveStallReason(makeCauseSubject(), { t, agent, ...extraCtx } as StallContext);
          expect(result?.code).toBe(expected);
        });
      }
    }

    it("still classifies a card that has no blocker of its own", () => {
      const { t } = makeT();
      const result = resolveStallReason(subject({ status: "in-progress" }), { t, agent: { pendingApprovalCount: 2 } });
      expect(result?.code).toBe("agent-approval");
    });

    it("still ranks behind a pause written on THIS card", () => {
      const { t } = makeT();
      const result = resolveStallReason(
        subject({ userPaused: true, pausedReason: "manual-intervention" }),
        { t, agent: { pendingApprovalCount: 2 } },
      );
      expect(result?.code).toBe("user-paused");
    });

    it("still ranks ahead of a review-lane code, whose dedicated badge renders on its own", () => {
      const { t } = makeT();
      const signal: InReviewStallSignal = { code: "merge-retries-exhausted", reason: "r", observedAt: ISO_T };
      const result = resolveStallReason(subject({ column: "in-review", inReviewStall: signal }), { t, agent: { pendingApprovalCount: 2 } });
      expect(result?.code).toBe("agent-approval");
    });

    it("does not outrank the server's own answer", () => {
      const { t } = makeT();
      const result = resolveStallReason(
        subject({ column: "in-review", stallReason: { code: "merge-blocker", reason: "pre-merge check failed", observedAt: ISO_T } }),
        { t, agent: { pendingApprovalCount: 2 } },
      );
      expect(result?.code).toBe("merge-blocker");
    });
  });

  it("wedge (active) uses its supplied descriptor prose and computes ageMs; resolved wedge is skipped", () => {
    const { t, call } = makeT();
    const active = resolveStallReason(
      subject({
        wedgeNotification: {
          reasonKey: "wedge-review",
          episodeId: "e1",
          status: "active",
          transitionedAt: ISO_T,
          pending: { since: ISO_T, reasonKey: "wedge-review", source: "supplied", reason: "review never dispatched", action: "Re-dispatch the review" },
        },
      }),
      { t, dataAsOfMs: T_MS + 3000 },
    );
    expect(active?.code).toBe("wedge");
    expect(active?.description).toBe("review never dispatched");
    expect(active?.suggestedAction).toBe("Re-dispatch the review");
    expect(active?.ageMs).toBe(3000);
    expect(call("stall.wedge.badgeLabel")).toMatchObject({ fallback: "Stuck" });

    const resolved = resolveStallReason(
      subject({ wedgeNotification: { reasonKey: "k", episodeId: "e", status: "resolved", transitionedAt: ISO_T } }),
      { t },
    );
    expect(resolved).toBeUndefined();
  });

  it("wedge without a descriptor asks the translator for a generic description", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(
      subject({ wedgeNotification: { reasonKey: "k", episodeId: "e", status: "active", transitionedAt: ISO_T } }),
      { t },
    );
    expect(result?.description).toBe("A durable stuck-state hold is in place on this card.");
    expect(call("stall.wedge.description")).toMatchObject({ fallback: "A durable stuck-state hold is in place on this card." });
  });

  it("dependency-block names the blocking task id on the face (symptom c)", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ blockedBy: "FN-42" }), { t });
    expect(result?.code).toBe("dependency-block");
    expect(call("stall.dependency-block.headline")!.resolved).toContain("FN-42");
    expect(call("stall.dependency-block.badgeLabel")).toMatchObject({ fallback: "Blocked" });
  });

  it("overlap-block names the overlapping task id", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ overlapBlockedBy: "FN-7" }), { t });
    expect(result?.code).toBe("overlap-block");
    expect(call("stall.overlap-block.headline")!.resolved).toContain("FN-7");
  });

  it("dependency-block outranks overlap-block when both edges exist", () => {
    const { t } = makeT();
    expect(resolveStallReason(subject({ blockedBy: "FN-1", overlapBlockedBy: "FN-2" }), { t })?.code).toBe("dependency-block");
  });

  it("merge-blocker / completion-blocker carry the context reason verbatim", () => {
    const { t, call } = makeT();
    const merge = resolveStallReason(subject(), { t, mergeBlockerReason: "pre-merge check 'lint' failed" });
    expect(merge?.code).toBe("merge-blocker");
    expect(merge?.description).toBe("pre-merge check 'lint' failed");
    expect(call("stall.merge-blocker.badgeLabel")).toMatchObject({ fallback: "Merge blocked" });

    const completion = resolveStallReason(subject(), { t, completionBlockerReason: "awaiting validation" });
    expect(completion?.code).toBe("completion-blocker");
    expect(completion?.description).toBe("awaiting validation");
  });

  it("failed carries the captured error and asks the translator for its badge", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ status: "failed", error: "tool timeout" }), { t });
    expect(result?.code).toBe("failed");
    expect(result?.description).toBe("tool timeout");
    expect(call("stall.failed.badgeLabel")).toMatchObject({ fallback: "Failed" });
  });

  it("queued only fires on an asserted queuedReason and reuses tasks.queued", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ queuedReason: "waiting for an execution slot" }), { t });
    expect(result?.code).toBe("queued");
    expect(call("tasks.queued")).toMatchObject({ fallback: "Queued" });
    expect(result?.description).toBe("waiting for an execution slot");
  });
});

describe("resolveStallReason — review-lane delegation is one authority", () => {
  it("in-review-stall returns exactly getInReviewStallCopy's fields (no re-authored copy)", () => {
    const { t } = makeT();
    const signal: InReviewStallSignal = { code: "merge-retries-exhausted", reason: "merge stalled", observedAt: ISO_T };
    const expected = getInReviewStallCopy(signal);
    const result = resolveStallReason(subject({ inReviewStall: signal }), { t });
    expect(result?.code).toBe("in-review-stall");
    expect(result?.badgeLabel).toBe(expected.badgeLabel);
    expect(result?.headline).toBe(expected.headline);
    expect(result?.description).toBe(expected.description);
    expect(result?.suggestedAction).toBe(expected.suggestedAction);
  });

  it("stale-paused-review returns exactly getStalePausedReviewCopy's fields", () => {
    const { t } = makeT();
    const signal: StalePausedReviewSignal = {
      code: "stale-paused-review",
      reason: "paused in review beyond threshold",
      observedAt: ISO_T,
      ageMs: 10,
      thresholdMs: 5,
    };
    const expected = getStalePausedReviewCopy(signal);
    // stale-paused-review sits below the pause family; exercise the delegate with a non-paused subject.
    const result = resolveStallReason(subject({ stalledReview: undefined, stalePausedReview: signal }), { t });
    expect(result?.code).toBe("stale-paused-review");
    expect(result?.badgeLabel).toBe(expected.badgeLabel);
    expect(result?.headline).toBe(expected.headline);
  });

  it("stalled-review localizes its own badge and shows the signal reason verbatim", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ stalledReview }), { t });
    expect(result?.code).toBe("stalled-review");
    expect(call("stall.stalled-review.badgeLabel")).toMatchObject({ fallback: "Stalled review" });
    expect(result?.description).toBe(stalledReview.reason);
  });
});

describe("resolveStallReason — age never consults the wall clock when dataAsOfMs is given", () => {
  it("computes ageMs purely from updatedAt/transitionedAt and dataAsOfMs", () => {
    const nowSpy = vi.spyOn(Date, "now");
    const { t } = makeT();
    const paused = resolveStallReason(subject({ paused: true }), { t, dataAsOfMs: T_MS + 1234 });
    expect(paused?.ageMs).toBe(1234);
    const wedge = resolveStallReason(
      subject({ wedgeNotification: { reasonKey: "k", episodeId: "e", status: "active", transitionedAt: ISO_T } }),
      { t, dataAsOfMs: T_MS + 999 },
    );
    expect(wedge?.ageMs).toBe(999);
    expect(nowSpy).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});

describe("resolveStallReason — every emitted code asks the translator for at least one key", () => {
  for (const [label, make] of Object.entries(clientChainFixtures)) {
    it(`${label} records at least one translated key`, () => {
      const { t, calls } = makeT();
      const fixture = make();
      const ctx = (fixture.ctx ?? {}) as Parameters<typeof resolveStallReason>[1];
      const result = resolveStallReason(fixture.subject, { ...ctx, t });
      expect(result).toBeDefined();
      expect(calls.length, `${label} produced no translator call`).toBeGreaterThan(0);
    });
  }
});

/*
FNXC:StallReason 2026-09-02-21:49 (RUFU-177):
RUFU-174's read path is the authority for "why is this card standing still?", so a present
`task.stallReason` must decide the classification ahead of every client-side branch — including the
external block, which the client chain used to rank first. These tests pin that outranking for EVERY
client code (one winner per cause: a card whose server answer is `dependency-blocker` must not also be
read as a client-side dependency/overlap/merge stall), the verbatim code identity that keeps the two
authorities distinguishable, and the two rules that protect the user from the server's internals:
the authority's free-text `reason` never becomes headline/badge copy, and a `{{taskId}}` template can
never reach the DOM uninterpolated.
*/

type ServerCode = "merge-blocker" | "pre-merge-gate-pending" | "dependency-blocker" | "held-human-review";

function serverStall(code: ServerCode | (string & {}), reason = "canonical blocker sentence from the authority") {
  return { code, reason, observedAt: ISO_T };
}

describe("resolveStallReason — the server field outranks the client classifier", () => {
  for (const [label, make] of Object.entries(clientChainFixtures)) {
    it(`${label}: a present server field wins and no client copy is requested`, () => {
      const { t, calls } = makeT();
      const fixture = make();
      const ctx = (fixture.ctx ?? {}) as Parameters<typeof resolveStallReason>[1];
      const withServer = { ...fixture.subject, stallReason: serverStall("dependency-blocker") };
      const result = resolveStallReason(withServer, { ...ctx, t });
      expect(result?.code).toBe("dependency-blocker");
      // Only the server's mapped copy was requested: none of the client branch's own keys appear.
      expect(calls.map((c) => c.key)).toContain("stall.dependency-block.badgeLabel");
      expect(calls.every((c) => c.key.startsWith("stall.dependency-block."))).toBe(true);
    });
  }

  it("keeps the client chain byte-identical when the server field is absent (regression pin)", () => {
    // Same fixture, same context, twice: once with no stallReason and once with the field explicitly
    // undefined (the shape the fresh-agent-log sanitizer produces). Both must classify identically.
    const a = makeT();
    const b = makeT();
    const fixture = clientChainFixtures.mergeBlocker!();
    const ctx = { ...(fixture.ctx ?? {}) } as Parameters<typeof resolveStallReason>[1];
    const withoutField = resolveStallReason(fixture.subject, { ...ctx, t: a.t });
    const withUndefined = resolveStallReason({ ...fixture.subject, stallReason: undefined }, { ...ctx, t: b.t });
    expect(withoutField).toEqual(withUndefined);
    expect(withoutField?.code).toBe("merge-blocker");
    expect(a.calls).toEqual(b.calls);
  });

  it("maps merge-blocker onto the localized merge copy while keeping the authority text as detail", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ column: "in-review", stallReason: serverStall("merge-blocker") }), { t });
    expect(result?.code).toBe("merge-blocker");
    expect(call("stall.merge-blocker.headline")!.fallback).toBe("Merge is blocked");
    expect(result?.description).toBe("canonical blocker sentence from the authority");
  });

  it("maps pre-merge-gate-pending onto the merge group but keeps its own code identity", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(
      subject({ column: "in-review", stallReason: serverStall("pre-merge-gate-pending", "pre-merge steps not run") }),
      { t },
    );
    // Same copy group as a real merge blocker (an unrun gate does block the merge) ...
    expect(call("stall.merge-blocker.badgeLabel")!.fallback).toBe("Merge blocked");
    // ... but a distinguishable code, so surfaces and tests can still tell the two causes apart.
    expect(result?.code).toBe("pre-merge-gate-pending");
    expect(result?.code).not.toBe("merge-blocker");
  });

  it("describes dependency-blocker with dependency copy, never with the merge wording", () => {
    const { t, call, keys } = makeT();
    const result = resolveStallReason(
      subject({ blockedBy: "FN-42", stallReason: serverStall("dependency-blocker") }),
      { t },
    );
    expect(result?.code).toBe("dependency-blocker");
    expect(call("stall.dependency-block.headline")!.resolved).toContain("FN-42");
    expect(keys().some((k) => k.startsWith("stall.merge-blocker."))).toBe(false);
    // The authority's sentence is not needed to name a dependency, so localized copy wins here.
    expect(result?.description).not.toContain("canonical blocker sentence");
  });

  it("falls back to a non-interpolating dependency headline when no single blocker is named", () => {
    const { t, call } = makeT();
    // The server also fires dependency-blocker for a `dependencies` edge, which carries no blockedBy id.
    const result = resolveStallReason(subject({ stallReason: serverStall("dependency-blocker") }), { t });
    expect(call("stall.dependency-block.headlineUnspecified")!.fallback).toBe("Waiting on a dependency");
    // A literal template token must never reach the DOM.
    expect(result?.headline).not.toContain("{{taskId}}");
    expect(call("stall.dependency-block.headline")).toBeUndefined();
  });

  it("describes held-human-review as waiting on a person and never as a blocked merge", () => {
    const { t, call, calls } = makeT();
    const result = resolveStallReason(
      subject({ column: "in-review", stallReason: serverStall("held-human-review", "Waiting on a human: automatic merge processing is withheld") }),
      { t },
    );
    expect(result?.code).toBe("held-human-review");
    expect(call("stall.held-human-review.headline")!.fallback).toBe("Waiting on a person");
    // No visible string may pair "merge" with "blocked": nothing is refusing this card.
    for (const c of calls) {
      const text = `${c.fallback} ${c.resolved}`;
      expect(text).not.toMatch(/blocked/i);
      if (/merge/i.test(text)) expect(text).not.toMatch(/blocked/i);
    }
    // The server's fixed English sentence is translator-owned prose, so it is NOT rendered verbatim.
    expect(result?.description).not.toContain("Waiting on a human:");
  });

  /*
  FNXC:ReviewRevisionWait 2026-09-29-16:47 (RUFU-280):
  The card whose reviewer asked for changes is the loop working, so the copy must not read as a refusal.
  The refusal wording lives behind two different codes now (`merge-blocker`, `pre-merge-gate-pending`), and
  this is the assertion that keeps a future edit from routing the revision wait back through them.
  */
  it("describes awaiting-review-revision as corrections in flight, never as a blocked merge", () => {
    const { t, call, calls } = makeT();
    const result = resolveStallReason(
      subject({ column: "in-review", stallReason: serverStall("awaiting-review-revision", "Code Review asked for changes that are not finished yet") }),
      { t },
    );
    expect(result?.code).toBe("awaiting-review-revision");
    expect(call("stall.awaiting-review-revision.headline")!.fallback).toBe("Applying review corrections");
    for (const c of calls) {
      const text = `${c.fallback} ${c.resolved}`;
      expect(text).not.toMatch(/blocked/i);
    }
    expect(call("stall.merge-blocker.badgeLabel")).toBeUndefined();
    // The server's fixed sentence is translator-owned prose, so it is NOT rendered verbatim.
    expect(result?.description).not.toContain("Code Review asked for changes");
  });

  it("routes awaiting-review-revision through its own copy group, not the merge blocker's", () => {
    const { t, keys } = makeT();
    const result = resolveStallReason(
      subject({ column: "in-review", stallReason: serverStall("awaiting-review-revision", "Code Review asked for changes that are not finished yet") }),
      { t },
    );
    // A distinguishable code AND a distinguishable copy group — the code alone would pass a shared table.
    expect(result?.code).not.toBe("merge-blocker");
    expect(keys().some((k) => k.startsWith("stall.merge-blocker."))).toBe(false);
    expect(keys().some((k) => k.startsWith("stall.awaiting-review-revision."))).toBe(true);
  });

  /*
  FNXC:StallReason 2026-09-02-22:06 (RUFU-177):
  `clearInReviewStallForFreshAgentLog` (useTasks.ts) blanks `stallReason` alongside the three sibling
  stall badges while an agent is visibly streaming logs, so the authority's answer disappears for a poll
  cycle. The card must then fall back to what its own row says rather than go silent — the sanitizer is a
  freshness heuristic, not a claim that nothing is wrong. The cleared shape (`stallReason: undefined`) is
  written here exactly as that helper returns it.
  */
  it("falls back to the client chain after the fresh-agent-log sanitizer blanks the server field", () => {
    const { t } = makeT();
    const live = subject({ column: "in-review", blockedBy: "FN-BLOCK", stallReason: serverStall("merge-blocker") });
    expect(resolveStallReason(live, { t })?.code).toBe("merge-blocker");
    const afterClear = { ...live, stallReason: undefined };
    expect(resolveStallReason(afterClear, { t })?.code).toBe("dependency-block");
  });

  /*
  FNXC:PlanningAdmissionStall 2026-09-25-19:31 (RUFU-273):
  The seven planning answers, asserted as a family rather than one at a time. The symptom this task removes
  is that an aged planning card said NOTHING, so a test that only proved "some planning copy appears" would
  pass even if all seven codes rendered the identical sentence — which is the failure mode worth guarding,
  because it is the cheap way to implement the feature. Each assertion below therefore has a non-vacuous
  control: the code stays distinct, the copy is distinct per code, the authority's English sentence is never
  rendered verbatim, and no label pairs "plan" with "failed".
  */
  const planningCodes = [
    "plan-admission-throttled",
    "plan-lane-ineligible",
    "plan-premise-held",
    "plan-spec-unreadable",
    "plan-recovery-backoff",
    "plan-no-admission",
    "recoverable-work",
  ] as const;

  it.each(planningCodes)("maps the server's %s answer onto its own copy group under its own code", (code) => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ column: "backlog", stallReason: serverStall(code) }), { t });
    // The code is carried verbatim: no folding into a client code, so `data-stall-code` stays exact.
    expect(result?.code).toBe(code);
    // Copy comes from THIS code's group, and its fallback is real English (an empty default would render
    // a bare key and would be indistinguishable from an unmapped code at a glance).
    expect(call(`stall.${code}.headline`)!.fallback.length).toBeGreaterThan(0);
    expect(call(`stall.${code}.badgeLabel`)!.fallback.length).toBeGreaterThan(0);
    // The authority's English diagnostic is policy prose the translator owns, never rendered verbatim.
    expect(result?.description).not.toContain("canonical blocker sentence");
    // A planning hold is a hold, not a failure: the chip must not send the operator to the failure lane.
    expect(`${result?.badgeLabel} ${result?.headline}`).not.toMatch(/fail/i);
    const faceCopy = `${result?.badgeLabel} ${result?.headline} ${result?.suggestedAction}`;
    if (code === "recoverable-work") {
      // Honest exception: this one IS about commits that never reached the default branch — naming that is
      // its whole content. What it must never do is borrow the merge-lane's refusal wording, because the
      // remedy is "recover the work", not "clear a merge blocker".
      expect(faceCopy).not.toMatch(/blocked/i);
      expect(call(`stall.${code}.headline`)!.fallback).toMatch(/not/i);
    } else {
      // The other six are planning-lane causes; sending the operator to the delivery lane to fix one is
      // the wording defect the `held-human-review` test above already refuses for the review lane.
      expect(faceCopy).not.toMatch(/merge/i);
    }
  });

  it("gives each planning cause different words, which is the whole point of naming seven of them", () => {
    const { t } = makeT();
    const headlines = planningCodes.map((code) => resolveStallReason(subject({ stallReason: serverStall(code) }), { t })?.headline);
    const badges = planningCodes.map((code) => resolveStallReason(subject({ stallReason: serverStall(code) }), { t })?.badgeLabel);
    // Seven distinct causes must produce seven distinct headlines and seven distinct chips; two codes
    // sharing a sentence would leave the operator asking the same question they asked before this feature.
    expect(new Set(headlines).size).toBe(planningCodes.length);
    expect(new Set(badges).size).toBe(planningCodes.length);
  });

  it("lets the server's planning answer outrank the client chain, which cannot name a planning cause", () => {
    const { t } = makeT();
    // An aged silent card with no client-side signal at all: the client chain has nothing to say about it.
    const bare = subject({ column: "backlog" });
    expect(resolveStallReason(bare, { t })).toBeUndefined();
    expect(resolveStallReason({ ...bare, stallReason: serverStall("plan-admission-throttled") }, { t })?.code)
      .toBe("plan-admission-throttled");
    // And when the client WOULD have guessed something, the server's planning answer still wins: it read
    // the episode, the client is inferring from a column name.
    const withClientCause = { ...bare, blockedBy: "FN-9", stallReason: serverStall("recoverable-work") };
    expect(resolveStallReason({ ...bare, blockedBy: "FN-9" }, { t })?.code).toBe("dependency-block");
    expect(resolveStallReason(withClientCause, { t })?.code).toBe("recoverable-work");
  });

  it("fails open to the client chain for a server code it does not know", () => {
    const { t } = makeT();
    const result = resolveStallReason(
      subject({ blockedBy: "FN-7", stallReason: serverStall("some-future-code") }),
      { t },
    );
    expect(result?.code).toBe("dependency-block");
  });
});

/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The WIP-admission family is one server code carrying eight gate-specific sentences, so the mapping job here
is narrower than the planning family's and sharper in one respect: the ELAPSED WAIT has to reach the card.
That number is the entire payload — "waiting 2 d 19 h for a work-in-progress slot" is what makes an
invisible refusal legible, and the operator-facing requirement was explicitly that the age be visible.
So the assertions below are about the interpolation, not just about a code surviving the trip: the wait must
be rendered from the server's `waitedMs` through core's humanizer, and its absence must degrade to honest
copy rather than a literal `{{waited}}` or a fabricated duration.
*/
describe("stallReason — the withheld hold→WIP crossing", () => {
  it("renders the elapsed wait from the server's waitedMs through the shared humanizer", () => {
    const { t } = makeT();
    const twoDays19Hours = (2 * 24 * 60 * 60_000) + (19 * 60 * 60_000);
    const result = resolveStallReason(
      subject({ column: "todo", stallReason: { ...serverStall("wip-admission-throttled"), waitedMs: twoDays19Hours } as never }),
      { t },
    );

    expect(result?.code).toBe("wip-admission-throttled");
    // The measured figure from the incident must survive, in human units, on the headline.
    expect(result?.headline).toContain("2 d 19 h");
    // A raw millisecond count or an untranslated placeholder would both read as a bug to an operator.
    expect(result?.headline).not.toContain("{{waited}}");
    expect(result?.headline).not.toContain(String(twoDays19Hours));
  });

  it("degrades to honest copy when the server reported no elapsed wait", () => {
    const { t } = makeT();
    const result = resolveStallReason(
      subject({ column: "todo", stallReason: serverStall("wip-admission-throttled") }),
      { t },
    );

    expect(result?.headline).toBeTruthy();
    expect(result?.headline).not.toContain("{{waited}}");
    // Inventing an age would be worse than saying nothing: the number is the operator's whole cue.
    expect(result?.headline).not.toMatch(/\bd\b\s*\d+\s*h/);
  });

  it("never renders the authority's English diagnostic sentence verbatim", () => {
    const { t } = makeT();
    const result = resolveStallReason(
      subject({ column: "todo", stallReason: { ...serverStall("wip-admission-throttled"), waitedMs: 7_200_000 } as never }),
      { t },
    );
    expect(result?.description).not.toContain("canonical blocker sentence");
    // It is a wait for capacity, not a failure — the chip must not send the operator to the failure lane.
    expect(`${result?.badgeLabel} ${result?.headline}`).not.toMatch(/fail/i);
  });

  it("outranks the client chain, which cannot know a refusal happened at all", () => {
    const { t } = makeT();
    // A card with a client-visible cause AND a WIP refusal: the refusal is the reason it is not running.
    const withClientCause = subject({ column: "todo", blockedBy: "FN-9", stallReason: serverStall("wip-admission-throttled") });
    expect(resolveStallReason(subject({ column: "todo", blockedBy: "FN-9" }), { t })?.code).toBe("dependency-block");
    expect(resolveStallReason(withClientCause, { t })?.code).toBe("wip-admission-throttled");
  });
});

/*
FNXC:StallReason 2026-09-02-22:01 (RUFU-177):
The face-visibility predicate is now the ONE arbiter behind four surfaces (card chip, desktop row, mobile
card, detail banner), and it is what decides the two decisions this task turns on: which server-backed
codes become a visible reason, and which ordinary review-lane waits stay off the card face but are still
named in the detail view. The expectation table is typed as an exhaustive `Record<StallReasonCode, …>`, so
adding a code to the union without deciding its visibility is a compile error rather than a silent
`default: false` — the drift that left merge-blocker with no visible reason in the first place.
*/

function makeStall(code: StallReasonCode): StallReason {
  return { code, badgeLabel: "badge", headline: "headline", description: "description", suggestedAction: "action" };
}

/** [visible with a pausedReason present, visible without one, visible to a detail surface (a card that
 *  names its pause reason, since the detail view is a superset of the face rather than a different list)] */
const faceExpectations: Record<StallReasonCode, readonly [boolean, boolean, boolean]> = {
  // The ExternalBlockNotice owns this cause; the predicate also drops every code while a block is present.
  "external-block": [false, false, false],
  // Dedicated affordances: the Needs-your-decision badge, the review badges/reason lines, the card-error
  // line, and the plain Queued badge already say these.
  "duplicate-decision": [false, false, false],
  "in-review-stall": [false, false, false],
  "stalled-review": [false, false, false],
  "stale-paused-review": [false, false, false],
  failed: [false, false, false],
  queued: [false, false, false],
  // The card's awaiting-approval affordance owns this one.
  "agent-approval": [false, false, false],
  /*
  FNXC:ProviderThrottleIsTransient 2026-09-30-14:58 (RUFU-286):
  Unlike `agent-approval` above, nothing else on the card says "rate limited", so the detail banner is
  this code's only surface — it may not be dropped entirely. It is NOT face-visible for the same reason
  the two ordinary review waits below it are not: the engine resolves the wait by itself on a bounded
  timer, so a chip would brand routine retry an abnormal state — and `pendingApprovalCount`-style
  per-ACTOR aggregation means one throttled agent would badge every card it owns.
  */
  "agent-rate-limited": [false, false, true],
  // A pause earns a visible reason only when it can name one.
  "agent-paused": [true, false, true],
  "user-paused": [true, false, true],
  "engine-paused": [true, false, true],
  // Faults and edges, client-derived or server-derived: one visible reason per cause.
  wedge: [true, true, true],
  "dependency-block": [true, true, true],
  "dependency-blocker": [true, true, true],
  "overlap-block": [true, true, true],
  // The flipped pair: an in-review card whose merge genuinely refuses used to name nothing anywhere.
  "merge-blocker": [true, true, true],
  "completion-blocker": [true, true, true],
  // Ordinary review-lane waits: named by the detail banner, never presented as a face-level fault.
  "pre-merge-gate-pending": [false, false, true],
  "held-human-review": [false, false, true],
  /*
  FNXC:ReviewRevisionWait 2026-09-29-16:45 (RUFU-280):
  Third ordinary-wait code: applying review corrections is the review loop mid-flight, so it is named by
  the detail banner and never presented as a face-level fault. The board already shows the card's pending
  remediation steps; a chip would mark routine revision abnormal.
  */
  "awaiting-review-revision": [false, false, true],
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-19:31 (RUFU-273):
  Every planning-lane code is face-visible in all three modes. This row is the acceptance for the reported
  symptom — an aged planning card that explained itself with nothing — so unlike the two ordinary waits
  directly above, none of these may be detail-only. They also do not depend on a `pausedReason`: a planning
  stall is named by the server's episode, not by a pause the card may not have.
  */
  "plan-admission-throttled": [true, true, true],
  /*
  FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
  An aged withheld hold→WIP crossing shows on the card face. The exhaustive `Record<StallReasonCode, …>`
  typing is what forces this decision — the storm was invisible precisely because a refusal had no face
  surface, and the code cannot exist until core proved the refusal outlived the escalation floor, so a
  visible chip here means a real stall rather than ordinary lane noise.
  */
  "wip-admission-throttled": [true, true, true],
  "plan-lane-ineligible": [true, true, true],
  "plan-premise-held": [true, true, true],
  "plan-spec-unreadable": [true, true, true],
  "plan-recovery-backoff": [true, true, true],
  "plan-no-admission": [true, true, true],
  "recoverable-work": [true, true, true],
};

describe("stallReasonVisibleOnFace — exhaustive per-code matrix", () => {
  for (const [code, [withReason, withoutReason, detailVisible]] of Object.entries(faceExpectations)) {
    it(`${code}: face ${withReason ? "shows" : "suppresses"} the chip (reason ${withoutReason ? "absent" : "irrelevant"}), detail ${detailVisible ? "shows" : "suppresses"} the banner`, () => {
      const stalled = makeStall(code as StallReasonCode);
      const namedPause = subject({ pausedReason: "budget-exhausted" });
      expect(stallReasonVisibleOnFace(namedPause, stalled)).toBe(withReason);
      expect(stallReasonVisibleOnFace(subject(), stalled)).toBe(withoutReason);
      // The detail surface sees a superset: every face code stays visible, plus the detail-only codes.
      expect(stallReasonVisibleOnFace(namedPause, stalled, { allowDetailOnlyCodes: true })).toBe(detailVisible);
      // No stall, no chip, in either mode.
      expect(stallReasonVisibleOnFace(subject(), undefined)).toBe(false);
    });
  }

  it("drops every code while the ExternalBlockNotice owns the cause, on both surfaces", () => {
    const blocked = subject({ status: "blocked", externalBlock: fullExternalBlock() });
    for (const code of Object.keys(faceExpectations) as StallReasonCode[]) {
      expect(stallReasonVisibleOnFace(blocked, makeStall(code)), code).toBe(false);
      expect(stallReasonVisibleOnFace(blocked, makeStall(code), { allowDetailOnlyCodes: true }), code).toBe(false);
    }
  });
});
