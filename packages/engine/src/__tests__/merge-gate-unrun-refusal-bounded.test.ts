import { beforeEach, describe, expect, it } from "vitest";

import {
  UNRUN_PRE_MERGE_GATE_REROUTE_TYPE,
  isBoundedFinalizationRefusal,
  resetFinalizationNoticeState,
  shouldEmitUnrunPreMergeGateNotice,
} from "../merge/finalization-refusal-notice.js";

/*
FNXC:UnrunGateRefusalBounded 2026-11-03-16:08 (RUFU-655):
The merge-gate arm of the unrun-gate re-seed emitted its audit row on every merge-lane pass, including when
it refused for the identical reason. Measured on this board: `RUFU-369` produced 23 rows in 12 minutes
(~30 s apart), all `reason: "active-continuation"`, while its own review attempt sat in `running`; over 24 h
`RUFU-386` carried 57 such rows, `RUFU-397` 25, `RUFU-450` 22, `RUFU-439` 17, `RUFU-451` 16. The rows are the
smaller cost — every one of them is also a merge-queue write, and they bury the `seeded` /
`verdictless-seeded` rows that actually describe a state change.

The invariant is asserted across EVERY refusal reason in the union, not only the reported reproduction,
because the emission site is one guard for the whole refusal vocabulary: a guard that happens to work for
`active-continuation` while a restated `no-review-route` still floods would leave the same defect on the
board under a different label.
*/

/** Every refusal the discriminated `UnrunPreMergeGateRerouteReason` union can produce. */
const REFUSAL_REASONS = [
  "rerun-budget-exhausted",
  "active-continuation",
  "no-unrun-gate",
  "no-review-route",
  "not-singular",
  "operator-held",
  "workflow-selection-changed",
] as const;

/** The two success values: both mean the graph was actually re-seeded. */
const SEED_REASONS = ["seeded", "verdictless-seeded"] as const;

beforeEach(() => {
  resetFinalizationNoticeState();
});

describe("merge-gate unrun-gate notice is bounded to state transitions", () => {
  it.each(REFUSAL_REASONS)("records the first '%s' refusal and suppresses every restatement", (reason) => {
    const first = { taskId: "RUFU-1", rerouted: false, reason, workflowStepId: "code-review", requiredGateCount: 2 };
    expect(shouldEmitUnrunPreMergeGateNotice(first)).toBe(true);
    // The merge lane polls again and again; a verbatim restatement must not write.
    expect(shouldEmitUnrunPreMergeGateNotice(first)).toBe(false);
    expect(shouldEmitUnrunPreMergeGateNotice(first)).toBe(false);
  });

  it.each(SEED_REASONS)("always records a real re-seed (%s), because the card changed", (reason) => {
    const seed = { taskId: "RUFU-2", rerouted: true, reason, workflowStepId: "code-review", requiredGateCount: 2 };
    expect(shouldEmitUnrunPreMergeGateNotice(seed)).toBe(true);
    expect(shouldEmitUnrunPreMergeGateNotice(seed)).toBe(true);
  });

  it("treats each changed dimension as a new state, so a passing refusal cannot hide the next one", () => {
    const base = { taskId: "RUFU-3", rerouted: false, reason: "active-continuation", workflowStepId: "code-review", requiredGateCount: 2 };
    expect(shouldEmitUnrunPreMergeGateNotice(base)).toBe(true);
    expect(shouldEmitUnrunPreMergeGateNotice(base)).toBe(false);

    // Which gate is refused is operator-relevant: the remediation differs.
    expect(shouldEmitUnrunPreMergeGateNotice({ ...base, workflowStepId: "post-merge-verification" })).toBe(true);
    // A second missing gate is a different problem than one.
    expect(shouldEmitUnrunPreMergeGateNotice({ ...base, requiredGateCount: 3 })).toBe(true);
    // A refusal that turns into a refusal for another reason is a transition.
    expect(shouldEmitUnrunPreMergeGateNotice({ ...base, reason: "no-review-route" })).toBe(true);
    // A gate that never names a step is its own state, not a blank repeat of a named one.
    expect(shouldEmitUnrunPreMergeGateNotice({ ...base, workflowStepId: undefined, reason: "no-unrun-gate" })).toBe(true);
  });

  it("keeps cards independent, so one quiet card cannot silence another", () => {
    const shape = { rerouted: false, reason: "active-continuation", workflowStepId: "code-review", requiredGateCount: 2 };
    expect(shouldEmitUnrunPreMergeGateNotice({ ...shape, taskId: "RUFU-A" })).toBe(true);
    expect(shouldEmitUnrunPreMergeGateNotice({ ...shape, taskId: "RUFU-B" })).toBe(true);
    expect(shouldEmitUnrunPreMergeGateNotice({ ...shape, taskId: "RUFU-A" })).toBe(false);
    expect(shouldEmitUnrunPreMergeGateNotice({ ...shape, taskId: "RUFU-B" })).toBe(false);
  });

  it("declares the re-seed arm bounded while leaving terminal outcomes unbounded", () => {
    expect(isBoundedFinalizationRefusal(UNRUN_PRE_MERGE_GATE_REROUTE_TYPE)).toBe(true);
    // The sibling no-action/terminal vocabulary must stay outside the bounded set: those rows are decisions.
    expect(isBoundedFinalizationRefusal("task:merge-unrun-gate-park-repaired")).toBe(false);
    expect(isBoundedFinalizationRefusal("task:merge-unrun-gate-retry-deferred")).toBe(false);
  });
});
