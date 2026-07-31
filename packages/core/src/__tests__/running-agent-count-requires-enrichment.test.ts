/*
FNXC:WorkflowLifecycleColumns 2026-07-30-12:40:

WHY AN UNENRICHED `countRunningAgentTasks` MISCOUNTS A RENAMED BOARD.

`isRunningAgentTask` reads trait-derived fields (`columnCountsTowardWip`,
`columnIsReviewOrMerge`, `columnTerminalKind`) and falls back to the legacy `in-progress` /
`in-review` literals when they are ABSENT. So the same task list yields different counts
depending on whether the caller enriched first — and on a renamed board the unenriched
answer is zero.

This pins the mechanism, which is what makes the CLI fix (packages/cli/src/commands/project.ts,
`fn project` output) more than a plausible-looking edit: that caller passed raw rows while the
dashboard's `project-store-resolver` enriched, so an operator checking whether the board was
busy was told "0 running" for a fully occupied renamed board.

SCOPE, stated rather than implied: this proves the PREDICATE needs enrichment and that
enrichment fixes it. It does NOT drive `fn project` end to end — `getTaskCounts` is private
behind project/central-store machinery, and standing that up would be a mock-the-world shell
(FN-5048) for a three-line change that mirrors an already-reviewed reference implementation.
*/
import { describe, expect, it } from "vitest";
import "../builtin-traits.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import { countRunningAgentTasks, enrichRunningAgentTaskShape } from "../live-agent-count.js";

/** A workflow whose wip column is `building` — no legacy id anywhere. */
const RENAMED_IR = {
  version: "v2",
  id: "custom:renamed",
  nodes: [{ id: "start", kind: "start", column: "queued" }, { id: "end", kind: "end", column: "shipped" }],
  edges: [{ from: "start", to: "end" }],
  columns: [
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as WorkflowIr;

const cardsInWip = [
  { id: "FN-1", column: "building", paused: false },
  { id: "FN-2", column: "building", paused: false },
] as never[];

describe("countRunningAgentTasks needs enriched traits on a renamed board", () => {
  it("UNENRICHED rows report zero running agents for a fully occupied wip column", () => {
    /* The bug, stated as a fact rather than a risk: the legacy fallback compares against
       `in-progress`, which this board does not have. */
    expect(countRunningAgentTasks(cardsInWip)).toBe(0);
  });

  it("ENRICHED rows report both cards — enrichment is what fixes it", () => {
    const enriched = cardsInWip.map((t) => enrichRunningAgentTaskShape(t, RENAMED_IR));
    expect(countRunningAgentTasks(enriched)).toBe(2);
  });

  it("a DEFAULT-vocabulary board counts the same either way (why this stayed hidden)", () => {
    /* The regression floor, and the explanation for the silence: on the built-in vocabulary
       the literal fallback happens to be right, so an unenriched caller looks correct
       forever and no test notices. */
    const legacy = [{ id: "FN-3", column: "in-progress", paused: false }] as never[];
    expect(countRunningAgentTasks(legacy)).toBe(1);
    expect(countRunningAgentTasks(legacy.map((t) => enrichRunningAgentTaskShape(t, RENAMED_IR)))).toBe(0);
  });

  it("does NOT count a card in the renamed COMPLETE column even when enriched", () => {
    /* The negative half: enrichment must not turn every card into a running agent. */
    const done = [{ id: "FN-4", column: "shipped", paused: false }] as never[];
    expect(countRunningAgentTasks(done.map((t) => enrichRunningAgentTaskShape(t, RENAMED_IR)))).toBe(0);
  });
});
