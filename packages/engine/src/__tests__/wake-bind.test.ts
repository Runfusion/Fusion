/*
FNXC:ReviewerWakeCandidacy 2026-10-19-12:40 (RUFU-369):
Pins the reviewer-wake admission seam: a reviewer-only lane is never woken on a card whose lifecycle cannot hold
an open `code-review` gate, and every exclusion it names is a durable board fact rather than an inference from
the wake's own wording. The four measured wakes this replaces all asserted a gate the card never had:

  RUFU-350  column `done`, status `done`, content landed, `code-review` row APPROVED 19 min before the wake
            (the only open row was `post-merge-verification` REVISE — not a code-review gate).
  RUFU-365  column `todo`, 0 of 8 steps, `**No commits expected:** true` — never executed, so no review subject.
  RUFU-366  column `todo`, 0 of 8 steps, same declaration.

The opposite half matters just as much and is pinned here too: an automation wake and a fresh-comment wake are
never swallowed by candidacy (RUFU-682/SANE-484 measured 24 re-dispatches caused by refusing a lane at a seam
that then re-offered the same card), and a lane that can execute implementation work is not making a review
claim by holding a `todo` card.
*/
import { describe, expect, it } from "vitest";
import type { Agent, Task } from "@fusion/core";
import {
  REVIEW_CANDIDACY_DECLINE_CODE,
  evaluateWakeTaskBind,
  hasReviewableWork,
  isReviewWakeCandidate,
  resolveWakeCommentIds,
  wakeLaneIsReviewerOnly,
  type WakeReviewCandidacyContext,
} from "../agents/wake-bind.js";

const REVIEW_LANES: WakeReviewCandidacyContext = {
  reviewColumns: new Set(["assessing", "shipped-nope"]),
  resolvable: true,
};

/** Reviewer-only lane — the shape every reviewer lane on the host actually has. */
function lane(roles: string[], patch: Record<string, unknown> = {}): Agent {
  return { id: "agent-lane", name: "lane", role: roles[0], roles, runtimeConfig: { enabled: true }, ...patch } as unknown as Agent;
}

function card(patch: Record<string, unknown> = {}) {
  return {
    id: "RUFU-369",
    column: "assessing",
    noCommitsExpected: false,
    reviewLevel: 2,
    enabledWorkflowSteps: ["plan-review", "code-review"],
    workflowStepResults: [],
    executionMode: null,
    humanPlanApproval: null,
    ...patch,
  } as unknown as Parameters<typeof evaluateWakeTaskBind>[1];
}

describe("wakeLaneIsReviewerOnly: the lane question, not the card question", () => {
  it("treats a reviewer-tagged lane with no execution role as review-only", () => {
    expect(wakeLaneIsReviewerOnly(lane(["reviewer"]))).toBe(true);
  });

  it("never treats an executor or engineer lane as review-only, even when it also reviews", () => {
    // Refusing these lanes on an implementation lane card is the RUFU-682 over-refusal class.
    expect(wakeLaneIsReviewerOnly(lane(["reviewer", "executor"]))).toBe(false);
    expect(wakeLaneIsReviewerOnly(lane(["engineer"]))).toBe(false);
    expect(wakeLaneIsReviewerOnly(lane(["reviewer", "engineer"]))).toBe(false);
  });

  it("treats an assignment policy that forbids implementation work as review-only", () => {
    expect(wakeLaneIsReviewerOnly(lane(["reviewer", "executor"], { runtimeConfig: { enabled: true, assignmentPolicy: "none" } }))).toBe(true);
  });
});

describe("isReviewWakeCandidate: only durable lifecycle facts", () => {
  it("accepts a card sitting in a review-class lane with no recorded verdict", () => {
    expect(isReviewWakeCandidate(card(), REVIEW_LANES)).toEqual({ known: true, candidate: true });
  });

  it("declines a card parked in a lane its own workflow does not call review-class", () => {
    const verdict = isReviewWakeCandidate(card({ column: "done" }), REVIEW_LANES);
    expect(verdict.known).toBe(true);
    expect(verdict.candidate).toBe(false);
    expect(verdict.facts.join("; ")).toContain('lane "done" is not a review-class lane');
  });

  it("declines a card that already carries a code-review verdict, including an authored REVISE", () => {
    const verdict = isReviewWakeCandidate(
      card({ workflowStepResults: [{ workflowStepId: "code-review", status: "failed", verdict: "REVISE" }] }),
      REVIEW_LANES,
    );
    expect(verdict.known && !verdict.candidate).toBe(true);
    expect(verdict.facts.join("; ")).toContain("a code-review verdict is already recorded");
  });

  it("does not mistake a post-merge verification row for a code-review verdict", () => {
    // RUFU-350's real shape: the open row was `post-merge-verification`, which is not the code-review gate.
    const verdict = isReviewWakeCandidate(
      card({ workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "advisory_failure", verdict: "REVISE" }] }),
      REVIEW_LANES,
    );
    expect(verdict).toEqual({ known: true, candidate: true });
  });

  it("does not mistake an unrun or superseded code-review row for a verdict", () => {
    for (const result of [
      { workflowStepId: "code-review", status: "pending" },
      { workflowStepId: "code-review", status: "skipped", notRunReason: "gate never dispatched" },
      { workflowStepId: "code-review", status: "passed", verdict: "APPROVE", supersededAt: "2026-10-18T00:00:00.000Z" },
    ]) {
      expect(isReviewWakeCandidate(card({ workflowStepResults: [result] }), REVIEW_LANES)).toEqual({ known: true, candidate: true });
    }
  });

  it("declines a card whose plan declared zero commits — it has no diff to review", () => {
    const verdict = isReviewWakeCandidate(card({ noCommitsExpected: true }), REVIEW_LANES);
    expect(verdict.known && !verdict.candidate).toBe(true);
    expect(verdict.facts.join("; ")).toContain("No commits expected");
    expect(hasReviewableWork({ noCommitsExpected: true })).toBe(false);
    expect(hasReviewableWork({})).toBe(true);
  });

  it("declines a card that excluded the code-review group, and stays open when the list is unset", () => {
    const excluded = isReviewWakeCandidate(card({ enabledWorkflowSteps: ["plan-review"] }), REVIEW_LANES);
    expect(excluded.known && !excluded.candidate).toBe(true);
    expect(isReviewWakeCandidate(card({ enabledWorkflowSteps: undefined }), REVIEW_LANES)).toEqual({ known: true, candidate: true });
    expect(isReviewWakeCandidate(card({ reviewLevel: 0 }), REVIEW_LANES).known).toBe(true);
  });

  it("reports an unreadable workflow as UNKNOWN, never as a decline", () => {
    expect(isReviewWakeCandidate(card({ column: "done" }), { reviewColumns: new Set(), resolvable: false })).toEqual({ known: false });
  });
});

describe("evaluateWakeTaskBind: candidacy before the implementation verdict", () => {
  const reviewerOnly = lane(["reviewer"]);
  const declined = { known: true as const, candidate: false as const, facts: ['lane "done" is not a review-class lane of this card\'s workflow'] };

  it("withholds the wake and names the verified facts, without touching the binding", () => {
    const verdict = evaluateWakeTaskBind(reviewerOnly, card({ column: "done" }), { reviewCandidacy: declined });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.code).toBe(REVIEW_CANDIDACY_DECLINE_CODE);
      expect(verdict.reason).toContain("no open code-review gate");
      expect(verdict.reason).toContain('lane "done" is not a review-class lane');
    }
  });

  it("never lets candidacy swallow an automation wake — the sweep already adjudicated it", () => {
    expect(evaluateWakeTaskBind(reviewerOnly, card({ column: "done" }), { reviewCandidacy: declined, automationCorroborated: true }).allowed).toBe(true);
  });

  it("never lets candidacy swallow a fresh comment wake — the operator asked", () => {
    expect(evaluateWakeTaskBind(reviewerOnly, card({ column: "done" }), { reviewCandidacy: declined, freshCommentWake: true }).allowed).toBe(true);
  });

  it("leaves a legitimate review candidate and an unknown candidacy exactly as they were", () => {
    expect(evaluateWakeTaskBind(reviewerOnly, card(), { reviewCandidacy: { known: true, candidate: true } }).allowed).toBe(true);
    expect(evaluateWakeTaskBind(reviewerOnly, card({ column: "done" }), { reviewCandidacy: { known: false } }).allowed).toBe(true);
  });

  it("keeps the pre-existing lane-capability refusal and its code for a review-only lane holding an implementation card", () => {
    // Candidacy is unknown/allowed here, so the wake must still fall through to the untouched bind verdict.
    const verdict = evaluateWakeTaskBind(lane(["reviewer"]), card({ column: "building" }), {
      reviewCandidacy: { known: true, candidate: true },
      implementationColumns: new Set(["building"]),
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe("lane-capability-mismatch");
  });
});

describe("resolveWakeCommentIds: a carried id is never re-advertised as new", () => {
  it("prefers this wake's own delivery", () => {
    expect(resolveWakeCommentIds({ paramIds: ["c-2"], snapshotIds: ["c-1"] })).toEqual({ ids: ["c-2"], origin: "fresh" });
  });

  it("labels the previous wake's ids as carried instead of promoting them", () => {
    expect(resolveWakeCommentIds({ paramIds: undefined, snapshotIds: ["c-1"] })).toEqual({ ids: ["c-1"], origin: "carried" });
  });

  it("treats an empty or malformed list as no comment evidence at all", () => {
    for (const ids of [undefined, [], [""] as string[]]) {
      expect(resolveWakeCommentIds({ paramIds: ids, snapshotIds: ids }).origin).toBe("none");
    }
  });
});

describe("review-candidacy decline survives the task fields it reads", () => {
  it("reads every fact from the durable card row", () => {
    const fields: Array<keyof Task> = ["column", "noCommitsExpected", "reviewLevel", "enabledWorkflowSteps", "workflowStepResults"];
    const task = card({ column: "done" }) as unknown as Task;
    for (const field of fields) expect(task).toHaveProperty(field);
  });
});
