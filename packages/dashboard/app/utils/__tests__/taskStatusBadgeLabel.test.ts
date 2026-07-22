import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { getTaskStatusBadgeLabel, hasTaskStatusBadge } from "../taskStatusBadgeLabel";

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

  it("maps needs-replan to the operator-facing Replan label", () => {
    expect(getTaskStatusBadgeLabel("needs-replan", t)).toBe("Replan");
  });

  it("passes through non-merge statuses", () => {
    expect(getTaskStatusBadgeLabel("planning", t)).toBe("planning");
    expect(getTaskStatusBadgeLabel("failed", t)).toBe("failed");
    expect(getTaskStatusBadgeLabel(null, t)).toBe("");
  });
});
