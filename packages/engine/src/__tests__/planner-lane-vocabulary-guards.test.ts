/*
FNXC:WorkflowLifecycleColumns 2026-07-30-11:10 (U11 — the last two planner-lane guards in my area):

Two guards that ask "is this card in a planner lane?" and answered with the literal
pair `triage`/`todo`. Both take their answer from the CALLER, which has the store,
so these are real conversions rather than seams nothing passes.

  mission-feature-sync `reconcileMissionFeatureState`
    A card back in a planner lane means the mission feature returns to `triaged`.
    Keyed on literals, a renamed workflow leaves the feature reading `in-progress`
    forever — the roadmap claims work is underway while the card sits waiting to be
    re-planned. Silent: nothing errors, the rollup is just wrong.

  spec-staleness `shouldSkipSpecStalenessForPreservedProgress`
    Returning `false` for a planner-lane card is what KEEPS staleness evaluation on
    for it. Miss the lane and the guard falls through to the preserved-progress
    branch, so a card with progress skips staleness and keeps a spec that should
    have been re-validated.

THE TWO TAKE DIFFERENT DEFAULTS, and that asymmetry is the point.

  mission-feature-sync gets the PAIR (`triage`/`todo`) — it asks "is this card
  waiting to be planned?", which is true in either lane.

  spec-staleness gets the DEDICATED planner column ONLY (`triage`). I defaulted it
  to the pair first and broke the pre-existing U11 proof in
  `spec-staleness.test.ts`, which says exactly why: "same column, different status,
  opposite correct answer". On a merged lineage `todo` is also the hold lane, so the
  planner distinction there is carried by STATUS, and treating the merged column as
  a planner lane stops a parked card with preserved progress from skipping
  staleness.

Written against the literal implementations and observed FAILING first.
*/
import { describe, expect, it } from "vitest";

import { reconcileMissionFeatureState } from "../mission-feature-sync.js";
import { shouldSkipSpecStalenessForPreservedProgress } from "../spec-staleness.js";

const RENAMED = ["inbox", "drafting"] as const;
/* spec-staleness takes the DEDICATED planner lane only — see the header. */
const RENAMED_DEDICATED = ["inbox"] as const;

describe("mission feature reconciliation under a renamed planner vocabulary", () => {
  const taskStore = { getTask: async () => undefined } as never;

  it("returns the feature to `triaged` for a card in a RENAMED planner lane", async () => {
    await expect(
      reconcileMissionFeatureState(
        taskStore,
        { id: "FN-1", column: "drafting", status: "pending" } as never,
        { id: "F-1", status: "in-progress" } as never,
        { plannerColumns: RENAMED },
      ),
    ).resolves.toMatchObject({ kind: "update", status: "triaged" });
  });

  it("does NOT return the feature for a card in a non-planner column", async () => {
    /* The negative half: the conversion must change which ids mean "planner lane",
       not make every column one. */
    await expect(
      reconcileMissionFeatureState(
        taskStore,
        { id: "FN-1", column: "shipped", status: "pending" } as never,
        { id: "F-1", status: "in-progress" } as never,
        { plannerColumns: RENAMED },
      ),
    ).resolves.not.toMatchObject({ status: "triaged" });
  });

  it("keeps the legacy pair when the caller supplies no vocabulary", async () => {
    for (const column of ["triage", "todo"]) {
      await expect(
        reconcileMissionFeatureState(
          taskStore,
          { id: "FN-1", column, status: "pending" } as never,
          { id: "F-1", status: "in-progress" } as never,
        ),
      ).resolves.toMatchObject({ kind: "update", status: "triaged" });
    }
  });
});

describe("spec staleness planner-lane guard under a renamed vocabulary", () => {
  const withProgress = { id: "FN-1", currentStep: 3, steps: [], status: null };

  it("keeps staleness ON for a card in a RENAMED planner lane", () => {
    expect(
      shouldSkipSpecStalenessForPreservedProgress({ ...withProgress, column: "inbox" } as never, RENAMED_DEDICATED),
    ).toBe(false);
  });

  it("still skips staleness for a card with progress OUTSIDE any planner lane", () => {
    /* The direction that must not change: preserved progress in a work column is
       exactly what this helper exists to protect. */
    expect(
      shouldSkipSpecStalenessForPreservedProgress({ ...withProgress, column: "building" } as never, RENAMED_DEDICATED),
    ).toBe(true);
  });

  it("keeps the legacy behaviour when the caller supplies no vocabulary", () => {
    expect(
      shouldSkipSpecStalenessForPreservedProgress({ ...withProgress, column: "triage" } as never),
    ).toBe(false);
    expect(
      shouldSkipSpecStalenessForPreservedProgress({ ...withProgress, column: "in-progress" } as never),
    ).toBe(true);
  });

  it("does NOT treat the MERGED column as a planner lane by default", () => {
    /* The U11 proof in spec-staleness.test.ts, restated where this conversion could
       break it: same column, different status, opposite correct answer. */
    expect(
      shouldSkipSpecStalenessForPreservedProgress({ ...withProgress, column: "todo" } as never),
    ).toBe(true);
    expect(
      shouldSkipSpecStalenessForPreservedProgress({ ...withProgress, column: "todo", status: "planning" } as never),
    ).toBe(false);
  });

  it("keeps the status-based escapes intact under a renamed vocabulary", () => {
    for (const status of ["needs-replan", "planning"]) {
      expect(
        shouldSkipSpecStalenessForPreservedProgress(
          { ...withProgress, column: "building", status } as never,
          RENAMED_DEDICATED,
        ),
      ).toBe(false);
    }
  });
});
