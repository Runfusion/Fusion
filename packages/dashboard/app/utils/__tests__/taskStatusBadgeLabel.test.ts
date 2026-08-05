import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { getTaskStatusBadgeLabel, hasTaskStatusBadge, isTaskPlanningActive, PLANNER_ACTIVITY_LIVE_WINDOW_MS } from "../taskStatusBadgeLabel";

const t = ((key: string, fallback?: string) => fallback ?? key) as TFunction<"app">;

describe("hasTaskStatusBadge", () => {
  it.each([
    "planning",
    "executing",
    "reviewing",
    "merging",
    "failed",
    "needs-replan",
    "done",
  ])("keeps a real status visible regardless of column placement: %s", (status) => {
    expect(hasTaskStatusBadge(status)).toBe(true);
  });

  it("leaves null, undefined, and empty status badge-free", () => {
    expect(hasTaskStatusBadge(null)).toBe(false);
    expect(hasTaskStatusBadge(undefined)).toBe(false);
    expect(hasTaskStatusBadge(" ")).toBe(false);
  });
});

describe("isTaskPlanningActive", () => {
  it("accepts planning status or fresh, unpaused planner activity on a replan card only", () => {
    const now = Date.parse("2026-08-05T10:05:00.000Z");
    expect(isTaskPlanningActive({ status: "planning" }, { globalPaused: true, now })).toBe(true);
    expect(isTaskPlanningActive({ status: "needs-replan", recentAgentActivityAt: "2026-08-05T10:01:00.000Z" }, { now })).toBe(true);
    expect(isTaskPlanningActive({ status: "needs-replan", recentAgentActivityAt: "2026-08-05T10:01:00.000Z" }, { globalPaused: true, now })).toBe(false);
    expect(isTaskPlanningActive({ status: "needs-replan" }, { now })).toBe(false);
    expect(isTaskPlanningActive({ status: undefined, recentAgentActivityAt: "2026-08-05T10:01:00.000Z" }, { now })).toBe(false);
  });

  it("expires historical or malformed planner activity", () => {
    const now = Date.parse("2026-08-05T10:05:00.000Z");
    expect(isTaskPlanningActive(
      { status: "needs-replan", recentAgentActivityAt: new Date(now - PLANNER_ACTIVITY_LIVE_WINDOW_MS - 1).toISOString() },
      { now },
    )).toBe(false);
    expect(isTaskPlanningActive({ status: "needs-replan", recentAgentActivityAt: "not-a-date" }, { now })).toBe(false);
  });
});

describe("getTaskStatusBadgeLabel", () => {
  it("maps the full AI merge pipeline to Merging…", () => {
    for (const status of ["merging", "merging-pr", "reviewing", "landing"]) {
      expect(getTaskStatusBadgeLabel(status, t)).toBe("Merging…");
    }
  });

  it("keeps merging-fix distinct", () => {
    expect(getTaskStatusBadgeLabel("merging-fix", t)).toBe("Merging fixes…");
  });

  it("keeps merging-fix over a still-running workflow-step label", () => {
    // A pre-merge step's running state can survive into a merge-fix retry; the badge must not regress to the step name.
    expect(getTaskStatusBadgeLabel("merging-fix", t, "Plan Review")).toBe("Merging fixes…");
  });

  it("keeps every active-merge status over a still-running workflow-step label", () => {
    // The same stale startedAt-without-completedAt step state can survive into the whole merge pipeline.
    for (const status of ["merging", "merging-pr", "reviewing", "landing"]) {
      expect(getTaskStatusBadgeLabel(status, t, "Code Review")).toBe("Merging…");
    }
  });

  it("lets a running workflow-step label override other statuses", () => {
    expect(getTaskStatusBadgeLabel("planning", t, "Plan Review")).toBe("Plan Review");
    expect(getTaskStatusBadgeLabel("needs-replan", t, "Plan Review")).toBe("Plan Review");
  });

  it("maps needs-replan to the operator-facing Revising label", () => {
    const label = getTaskStatusBadgeLabel("needs-replan", t);
    expect(label).toBe("Revising");
    expect(label).not.toBe("Replan");
  });

  /*
  FNXC:TaskStatusBadge 2026-07-26-14:05:
  With the Plan Review gate badge naming itself, callers drop the workflow-step override while it
  renders — so this branch is now what a planning card actually reads, and it must be operator copy
  rather than the raw engine token it used to expose.
  */
  it("maps the planning status to operator copy, not the engine token", () => {
    expect(getTaskStatusBadgeLabel("planning", t)).toBe("Planning");
  });

  it("passes through non-merge statuses", () => {
    expect(getTaskStatusBadgeLabel("failed", t)).toBe("failed");
    expect(getTaskStatusBadgeLabel(null, t)).toBe("");
  });
});
