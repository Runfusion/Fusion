import { describe, expect, it } from "vitest";

import {
  REVIEW_VERDICT_MARKER,
  buildMergeSystemPrompt,
  buildReviewSystemPrompt,
  parseReviewVerdict,
} from "../merger-ai.js";

describe("merger-ai prompt/verdict re-exports", () => {
  it("fails safe to a blocking reject for empty reviewer output", () => {
    expect(parseReviewVerdict("")).toEqual({
      verdict: "reject",
      reasons: ["reviewer produced no output"],
      severity: "blocking",
    });
  });

  it("fails safe to a blocking reject for garbled reviewer output", () => {
    expect(parseReviewVerdict("looks good, ship it")).toEqual({
      verdict: "reject",
      reasons: [
        `reviewer did not emit a "${REVIEW_VERDICT_MARKER} approve|reject" line`,
      ],
      severity: "blocking",
    });
  });

  it("treats a reject without explicit severity as blocking", () => {
    expect(
      parseReviewVerdict(
        `${REVIEW_VERDICT_MARKER} reject\n- dropped a conflict hunk`
      )
    ).toEqual({
      verdict: "reject",
      reasons: ["dropped a conflict hunk"],
      severity: "blocking",
    });
  });

  it("honors explicit advisory severity and excludes severity from reasons", () => {
    expect(
      parseReviewVerdict(
        `${REVIEW_VERDICT_MARKER} reject\nSEVERITY: advisory\n- commit message is vague`
      )
    ).toEqual({
      verdict: "reject",
      reasons: ["commit message is vague"],
      severity: "advisory",
    });
  });

  it("parses the approve line", () => {
    expect(
      parseReviewVerdict(`All reviewed.\n${REVIEW_VERDICT_MARKER} approve`)
    ).toEqual({
      verdict: "approve",
      reasons: [],
    });
  });

  it("extracts inline and bulleted reject reasons", () => {
    expect(
      parseReviewVerdict(
        `${REVIEW_VERDICT_MARKER} reject: lost generated types\nSEVERITY: blocking\n1. dropped api.ts\n- skipped docs update`
      )
    ).toEqual({
      verdict: "reject",
      reasons: [
        "lost generated types",
        "dropped api.ts",
        "skipped docs update",
      ],
      severity: "blocking",
    });
  });

  it("keeps non-negotiable clean-room and verdict-marker prompt content", () => {
    expect(buildMergeSystemPrompt()).toContain("## AI merge — clean room");
    expect(buildMergeSystemPrompt()).toContain(
      "Finish with exactly ONE new commit"
    );
    expect(buildReviewSystemPrompt()).toContain(REVIEW_VERDICT_MARKER);
    expect(buildReviewSystemPrompt()).toContain("Do NOT edit, stage, commit");
  });
});

/*
FNXC:MergerAiReview 2026-07-15-21:50 (FN-8004 follow-up):
The prompt says "End with a single decision line", so a COMPLIANT reviewer puts its reasoning
ABOVE `REVIEW_VERDICT: reject` and ends on the verdict. The parser only scanned lines AFTER the
verdict, so those reasons were dropped and every such rejection degraded to the placeholder
"reviewer rejected the merge without a stated reason" — which was then handed to the corrective
re-merge pass AS its instruction, making the pass a blind re-roll.

Observed on FN-8004's own merge: both attempts ran reject(no reason) → corrective pass → approve,
~7 min per wasted cycle, pushing each attempt past main's ~8-min churn window into a livelock.

Per "Fix the Invariant, Not the Repro": the invariant is that a reviewer's stated reasons reach the
corrective pass REGARDLESS of which side of the verdict line they were written on.
*/
describe("parseReviewVerdict — reason recovery (FN-8004)", () => {
  it("recovers reasons written ABOVE a trailing verdict line", () => {
    // The exact layout the prompt's "End with a single decision line" produces.
    const result = parseReviewVerdict(
      [
        "The squash drops the run-audit event added by the task branch.",
        "SEVERITY: blocking",
        `${REVIEW_VERDICT_MARKER} reject`,
      ].join("\n")
    );
    expect(result.verdict).toBe("reject");
    expect(result.severity).toBe("blocking");
    expect(result.reasons).toEqual([
      "The squash drops the run-audit event added by the task branch.",
    ]);
    // The regression: this used to be the placeholder.
    expect(result.reasons).not.toContain(
      "reviewer rejected the merge without a stated reason"
    );
  });

  it("orders recovered reasons nearest-the-verdict first (the closing argument)", () => {
    const result = parseReviewVerdict(
      [
        "- first observation",
        "- final blocking defect",
        `${REVIEW_VERDICT_MARKER} reject`,
      ].join("\n")
    );
    expect(result.reasons).toEqual(["final blocking defect", "first observation"]);
  });

  it("prefers reasons AFTER the verdict when both sides have content", () => {
    // Precedence must not change for reviewers that already follow the old layout.
    const result = parseReviewVerdict(
      [
        "some preamble analysis",
        `${REVIEW_VERDICT_MARKER} reject`,
        "- dropped api.ts",
      ].join("\n")
    );
    expect(result.reasons).toEqual(["dropped api.ts"]);
  });

  it("ignores markdown scaffolding, severity, and the verdict line itself", () => {
    const result = parseReviewVerdict(
      [
        "## Review",
        "---",
        "```",
        "SEVERITY: blocking",
        "genuine defect here",
        `${REVIEW_VERDICT_MARKER} reject`,
      ].join("\n")
    );
    expect(result.reasons).toEqual(["genuine defect here"]);
  });

  it("caps recovered reasons so a long transcript cannot flood the corrective prompt", () => {
    const body = Array.from({ length: 30 }, (_, i) => `- reason ${i}`);
    const result = parseReviewVerdict(
      [...body, `${REVIEW_VERDICT_MARKER} reject`].join("\n")
    );
    expect(result.reasons.length).toBeLessThanOrEqual(8);
    expect(result.reasons[0]).toBe("reason 29");
  });

  it("still reports the placeholder when the reviewer truly stated nothing", () => {
    const result = parseReviewVerdict(`${REVIEW_VERDICT_MARKER} reject`);
    expect(result.reasons).toEqual([
      "reviewer rejected the merge without a stated reason",
    ]);
  });

  it("does not attach reasons to an approve verdict", () => {
    const result = parseReviewVerdict(
      `Everything checks out.\n${REVIEW_VERDICT_MARKER} approve`
    );
    expect(result).toEqual({ verdict: "approve", reasons: [] });
  });

  it("gives the reviewer an unambiguous, self-consistent ordering instruction", () => {
    const prompt = buildReviewSystemPrompt();
    // The old prompt said BOTH "End with a single decision line" AND "Then list each
    // concrete reason as a bullet" — impossible to satisfy simultaneously, and the
    // direct cause of reasons landing where the parser could not see them.
    expect(prompt).toContain("first list each concrete reason");
    expect(prompt).toContain("nothing after it");
    expect(prompt).not.toMatch(/End with a single decision line[\s\S]*Then list each concrete reason/);
  });
});
