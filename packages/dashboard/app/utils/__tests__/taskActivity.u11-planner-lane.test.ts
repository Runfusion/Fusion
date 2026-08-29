/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
`isTaskAgentActive` under the U11 COLUMN SHAPE — merged pre-implementation column keeps
the id `todo`, `triage` is deleted.

FNXC:TaskActivity 2026-08-01-17:53:
Rewritten for the "never show more than actual" requirement: the fresh planner-log window
and `needs-replan` chrome are removed, so planner-lane glow now requires the authoritative
`planning` status (the same signal admission counts). A card whose planner logs stream in
before the status row lands stays dark for that brief window — under-reporting is the
accepted direction; over-reporting read as a concurrency-cap breach (10 glowing cards under
a 9-slot limit).
*/
import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { isTaskAgentActive } from "../taskActivity";

function plannerCard(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-U11",
    column: "todo",
    status: undefined,
    steps: [],
    recentAgentActivityAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Task;
}

describe("isTaskAgentActive planner lane (U11 merged column)", () => {
  it("glows a live planning card on the merged planning column", () => {
    expect(isTaskAgentActive(plannerCard({ status: "planning" as Task["status"] }), { columnFlags: { intake: true, hold: true } })).toBe(true);
  });

  it("does not glow fresh planner logs without the authoritative planning status", () => {
    // The log stream is not a slot; only the engine's planning status counts.
    expect(isTaskAgentActive(plannerCard(), { columnFlags: { intake: true, hold: true } })).toBe(false);
    expect(isTaskAgentActive(plannerCard({ column: "triage" as Task["column"] }), {})).toBe(false);
  });

  it("does not glow a hold-lane replan park — it holds no concurrency slot", () => {
    expect(isTaskAgentActive(plannerCard({ status: "needs-replan" as Task["status"] }), { columnFlags: { hold: true } })).toBe(false);
  });

  it("still glows a planning card without resolved column metadata", () => {
    expect(isTaskAgentActive(plannerCard({ status: "planning" as Task["status"] }), {})).toBe(true);
  });
});
