/*
FNXC:MergeReviewConfirmation 2026-08-26-10:11:
The AI merge review's approval line is a CONTRACT, not a message: `SelfHealingManager` parses it back
out of the task log to learn which squash SHAs were approved, and gates a recovery path on finding one.

Both sides were individually reasonable and had never been compared. The emitter wrote
`AI merge review: approved squash <sha>`; the parser required `AI merge review (pass N): approved …`.
So the parser matched nothing, `hasApprovedAiMergeReview` always answered false, and the recovery it
guards could not run — a dead path, invisible, with no failing test anywhere.

The same line is also written TWICE per squash by design: landing requires two consecutive clean
approvals of the same candidate. Word for word, that read to an operator as a duplicated invocation,
and was reported as an anomaly. The pass number makes the safety feature legible.

These tests pin emitter and parser against each other. Either one drifting alone fails here.
*/
import { describe, expect, it } from "vitest";

/** The exact expression SelfHealingManager uses to recover approved SHAs from the journal. */
const SELF_HEALING_APPROVAL_RE = /AI merge review \(pass \d+\): approved(?:\s+(?:squash|commit)\s+([0-9a-f]{7,40}))?/i;

const SHA = "784ab76e192b88f4c5764e893031e05396c19fdd";

/** Mirrors the emitter in merger-ai.ts; the source guard below proves it has not drifted. */
function approvalLine(pass: number, options: { unconfirmed?: number } = {}): string {
  const suffixes = [
    options.unconfirmed ? `${options.unconfirmed} prior finding(s) unconfirmed` : "",
    pass >= 2 ? "confirmation pass" : "",
  ].filter(Boolean);
  return `AI merge review (pass ${pass}): approved squash ${SHA}${suffixes.length ? ` — ${suffixes.join("; ")}` : ""}`;
}

describe("AI merge review approval line contract", () => {
  it("is parseable by the self-healing recovery that consumes it", () => {
    const match = approvalLine(1).match(SELF_HEALING_APPROVAL_RE);
    expect(match, "the recovery path finds no approved SHA if this stops matching").not.toBeNull();
    expect(match?.[1]).toBe(SHA);
  });

  it("keeps the SHA reachable when optional clauses are present", () => {
    // The capture requires the SHA immediately after `approved`; a clause inserted before it would
    // silently push the SHA out of reach and re-create the dead path.
    const match = approvalLine(2, { unconfirmed: 3 }).match(SELF_HEALING_APPROVAL_RE);
    expect(match?.[1]).toBe(SHA);
  });

  /* Two clean approvals are required before landing; the operator must be able to tell them apart. */
  it("distinguishes the confirmation pass from the first approval", () => {
    const first = approvalLine(1);
    const second = approvalLine(2);

    expect(first).not.toBe(second);
    expect(second).toContain("confirmation pass");
    expect(first).not.toContain("confirmation pass");
    for (const line of [first, second]) expect(line).toMatch(SELF_HEALING_APPROVAL_RE);
  });

  /*
  Structural guard: the emitter and the parser live in different files, which is exactly how they
  drifted. Pin both literals so a one-sided edit fails here instead of silently killing the recovery.
  */
  it("holds emitter and parser to the same shape", async () => {
    const { readFile } = await import("node:fs/promises");

    const emitter = await readFile(new URL("../merge/merger-ai.ts", import.meta.url), "utf8");
    expect(emitter, "the emitter must write the parenthetical the parser requires")
      .toContain("AI merge review (pass ${approvalNumber}): approved squash ${candidateSha}");

    const consumer = await readFile(new URL("../self-healing.ts", import.meta.url), "utf8");
    expect(consumer).toContain("AI merge review \\(pass \\d+\\): approved");
  });
});
