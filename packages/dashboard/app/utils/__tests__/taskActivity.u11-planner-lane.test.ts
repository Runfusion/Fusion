/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
`isTaskAgentActive` under the U11 COLUMN SHAPE — merged pre-implementation column keeps
the id `todo`, `triage` is deleted.

This predicate is the one that matters most in the dashboard drift, and it is not a
badge: it drives the pulsing status badge, the agent-active row border, AND the column
header's executing count. Its fresh-planner-activity clause was keyed on
`column === "triage"`, so once U11 lands a planning card with live planner logs reads as
IDLE everywhere at once — the board quietly stops reporting that planning is happening,
with nothing failing.

REVERT CHECK: drop the `columnFlags` branch and "merged planning column" fails — the card
is in `todo` without `needs-replan`, which the legacy clause does not recognise as a
planner lane.
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
  it("recognises fresh planner activity on the merged planning column", () => {
    // intake + hold, id `todo` — the post-U11 shape. Without the trait branch this is
    // false, because the legacy clause only accepts `triage` (or `todo` while replanning).
    expect(isTaskAgentActive(plannerCard(), { columnFlags: { intake: true, hold: true } })).toBe(true);
  });

  it("still recognises the legacy triage lane when no flags are supplied", () => {
    // The fallback path: callers without resolved metadata keep today's behaviour.
    expect(isTaskAgentActive(plannerCard({ column: "triage" as Task["column"] }), {})).toBe(true);
  });

  it("does NOT treat a hold lane as a planner lane unless it is replanning", () => {
    // The `hold && isReplanning` half, preserved from the legacy `todo && needs-replan`
    // clause — a card merely waiting for capacity is not agent-active.
    expect(isTaskAgentActive(plannerCard(), { columnFlags: { hold: true } })).toBe(false);
    expect(
      isTaskAgentActive(plannerCard({ status: "needs-replan" as Task["status"] }), { columnFlags: { hold: true } }),
    ).toBe(true);
  });

  it("does not report activity for a stale planner timestamp", () => {
    const stale = plannerCard({ recentAgentActivityAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    expect(isTaskAgentActive(stale, { columnFlags: { intake: true, hold: true } })).toBe(false);
  });
});
