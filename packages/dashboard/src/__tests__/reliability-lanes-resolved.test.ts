// @vitest-environment node

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:58:
THE RELIABILITY ENDPOINT'S THREE LANE READS, on a RENAMED board.

`/api/health/reliability` asks three lane questions: which lanes are REVIEW, which count toward WIP,
and which are COMPLETE. They feed the entered/bounced counts and the review -> done duration metric.

WHY THIS FILE EXISTS. All three were UNCOVERED. Blinding any of them left the entire dashboard suite
green — 21,582 tests — because they sat inline in the route closure and nothing drives that route.

AND WHY THE OBVIOUS TEST WOULD NOT HAVE HELPED. `reliability-metrics.test.ts` exercises
`countEntriesInto`, `countBouncesOut` and `inReviewDurationMetrics` with lane sets passed in BY HAND.
That proves the collaborators honour a resolved set; it says nothing about whether the caller passes
one. A unit test of the collaborator can never fail when the caller's resolve is blinded. The seam
under test here is the CALLER: `resolveReliabilityLanes` resolves, so blinding a resolve fails it.

WHAT BREAKS WITHOUT THE CONVERSION. On a board that renames either lane, every underlying query
returns {} — so `tasksEnteredInReview` and `tasksBouncedToInProgress` are zero for every day, and
`inReviewFailureRate7d` divides one zero by another and reports a healthy rate. That is the worst
shape a lifecycle defect takes: it produces a NUMBER, not an error, and the number says everything is
fine. An operator reading 0% review failures beside a populated audit list has no reason to suspect
the metric is blind.

DIFFERENTIAL. The same workflow SHAPE under two vocabularies with identical traits; only the ids
differ, and no renamed id collides with a legacy one. The default-vocabulary cases are controls.
*/

import { describe, expect, it, vi } from "vitest";
import { resolveReliabilityLanes } from "../reliability-metrics.js";

const RENAMED = { review: "signoff", wip: "building", complete: "shipped" };

function ir(names: { review: string; wip: string; complete: string }) {
  return {
    version: "v2",
    id: "custom:renamed-reliability",
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: names.wip, label: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: names.review, label: "Review", traits: [{ trait: "merge" }, { trait: "human-review" }] },
      { id: names.complete, label: "Complete", traits: [{ trait: "complete" }] },
    ],
  };
}

/** A store that can answer differently from the legacy floor — i.e. one with workflow definitions. */
function storeWith(names: { review: string; wip: string; complete: string }) {
  return {
    listWorkflowDefinitions: vi.fn(async () => [{ ir: ir(names) }]),
    getWorkflowDefinition: vi.fn(async () => ({ ir: ir(names) })),
  } as unknown as Parameters<typeof resolveReliabilityLanes>[0];
}

describe("resolveReliabilityLanes", () => {
  it("default vocabulary: resolves the built-in review, wip and complete lanes", async () => {
    const lanes = await resolveReliabilityLanes(
      storeWith({ review: "in-review", wip: "in-progress", complete: "done" }),
    );

    expect([...lanes.review]).toContain("in-review");
    expect([...lanes.wip]).toContain("in-progress");
    expect([...lanes.complete]).toContain("done");
  });

  it("renamed vocabulary: resolves the board's OWN review lane", async () => {
    const lanes = await resolveReliabilityLanes(storeWith(RENAMED));
    expect([...lanes.review]).toContain(RENAMED.review);
  });

  it("renamed vocabulary: resolves the board's OWN wip lane", async () => {
    const lanes = await resolveReliabilityLanes(storeWith(RENAMED));
    expect([...lanes.wip]).toContain(RENAMED.wip);
  });

  it("renamed vocabulary: resolves the board's OWN complete lane", async () => {
    const lanes = await resolveReliabilityLanes(storeWith(RENAMED));
    expect([...lanes.complete]).toContain(RENAMED.complete);
  });

  it("keeps the three roles distinct — a renamed lane does not leak across buckets", async () => {
    /*
    The paired negative. Three resolves in one function invite a copy-paste that hands the same set
    to all three; every positive above would still pass, and the duration metric would then measure
    review -> review. Each renamed lane must appear in ITS bucket and nowhere else.
    */
    const lanes = await resolveReliabilityLanes(storeWith(RENAMED));

    expect([...lanes.review]).not.toContain(RENAMED.wip);
    expect([...lanes.review]).not.toContain(RENAMED.complete);
    expect([...lanes.wip]).not.toContain(RENAMED.review);
    expect([...lanes.wip]).not.toContain(RENAMED.complete);
    expect([...lanes.complete]).not.toContain(RENAMED.review);
    expect([...lanes.complete]).not.toContain(RENAMED.wip);
  });

  it("degrades to the legacy floor when the board cannot be read", async () => {
    /* An unreadable workflow list must not fail the endpoint; the legacy ids still answer. */
    const lanes = await resolveReliabilityLanes({
      listWorkflowDefinitions: vi.fn(async () => {
        throw new Error("unreadable");
      }),
    } as unknown as Parameters<typeof resolveReliabilityLanes>[0]);

    expect([...lanes.review]).toContain("in-review");
    expect([...lanes.wip]).toContain("in-progress");
    expect([...lanes.complete]).toContain("done");
  });
});
