/*
FNXC:WorkflowResolvedColumns 2026-07-30-16:45 (batch-dashboard-src):

THE PRODUCER SIDE OF THE METRICS SEAM — the half its own tests cannot see.

`formatTaskPlannerChatMetrics` takes a `wipColumns` set so "is this card still accruing active
runtime?" is the WIP role rather than the id `in-progress`. Its unit tests inject that set by hand,
which proves the FORMATTER and says nothing about whether anything in production fills it. That is
the inert-injection shape this program keeps re-finding: the guard reads as converted, the test
passes by supplying the interesting value itself, and the literal stays live on every real call.

MEASURED, not assumed. With this file absent, deleting `wipColumns:` from the tool's call site left
the entire 3830-test dashboard suite green. `check-inert-flag-seams.mjs` did not catch it either — it
tracks trailing optional PARAMETERS, and this is a property inside an options bag. So the wiring had
no watcher at all, from either direction.

This test therefore drives `createTaskPlannerMetricsTool` and lets it do its OWN resolution against a
store whose workflow renames the execution lane. When a fix moves data from producer to consumer, the
test has to sit on the producer.
*/
import { describe, expect, it, vi } from "vitest";
import { createTaskPlannerMetricsTool } from "../chat.js";
import "@fusion/core"; // registers the built-in column traits so flags resolve

/** `building` carries the wip trait; this board declares no `in-progress` column at all. */
const RENAMED_IR = {
  version: "v2",
  id: "wf-renamed",
  name: "renamed",
  nodes: [],
  edges: [],
  columns: [
    { id: "drafting", name: "Drafting", traits: [{ trait: "intake" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

const NOW = "2026-07-01T10:05:00.000Z";

function storeFor(column: string) {
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const task = {
    id: "FN-1",
    title: "running card",
    description: "",
    column,
    status: "executing",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    executionStartedAt: "2026-07-01T10:00:00.000Z",
    cumulativeActiveMs: 60_000,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
  return {
    getTask: vi.fn(async () => task),
    getTaskWorkflowSelection: () => selection,
    getTaskWorkflowSelectionAsync: async () => selection,
    getWorkflowDefinition: async () => ({ id: "wf-renamed", ir: RENAMED_IR }),
  } as never;
}

async function activeRuntimeMsFrom(column: string): Promise<number | null> {
  const tool = createTaskPlannerMetricsTool(storeFor(column), "FN-1", async () => undefined);
  vi.setSystemTime(new Date(NOW));
  try {
    const result = await tool.execute();
    return (result as { details: { timing: { activeRuntimeMs: number | null } } }).details.timing
      .activeRuntimeMs;
  } finally {
    vi.useRealTimers();
  }
}

describe("the planner metrics tool resolves the task's own wip lanes", () => {
  it("accrues the live tail for a card in a RENAMED execution lane", async () => {
    /*
    60s banked plus 300s since `executionStartedAt`. Without the wiring the formatter falls back to
    the legacy `in-progress`, `building` does not match, and this reports 60_000 — a running task
    whose active time is frozen at its last completed segment, which looks plausible enough that
    nothing surfaces it.
    */
    expect(await activeRuntimeMsFrom("building")).toBe(360_000);
  });

  it("does NOT accrue for a card outside its board's wip lanes", async () => {
    /*
    The paired negative. Without it, wiring that resolved to "every column" would pass the case above
    and silently accrue active runtime for finished work.
    */
    expect(await activeRuntimeMsFrom("shipped")).toBe(60_000);
  });
});
