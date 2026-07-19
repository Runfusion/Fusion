import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { getTaskStatusBadgeLabel, shouldSuppressPlanningStatusBadge } from "../taskStatusBadgeLabel";

const t = ((key: string, fallback?: string) => fallback ?? key) as TFunction<"app">;

describe("shouldSuppressPlanningStatusBadge", () => {
  it.each([
    { status: "planning", column: "todo", suppressed: true },
    { status: "planning", column: "in-progress", suppressed: true },
    { status: "planning", column: "triage", suppressed: false },
    { status: "executing", column: "todo", suppressed: false },
    { status: "executing", column: "in-progress", suppressed: false },
    { status: "reviewing", column: "todo", suppressed: false },
    { status: "merging", column: "in-progress", suppressed: false },
    { status: "failed", column: "todo", suppressed: false },
    { status: "needs-replan", column: "in-progress", suppressed: false },
    { status: "done", column: "todo", suppressed: false },
    { status: null, column: "in-progress", suppressed: false },
    { status: undefined, column: "todo", suppressed: false },
  ])("suppresses only stale planning status for Todo and In Progress: $status/$column", ({ status, column, suppressed }) => {
    expect(shouldSuppressPlanningStatusBadge({ status, column })).toBe(suppressed);
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

  it("maps needs-replan to the operator-facing Replan label", () => {
    expect(getTaskStatusBadgeLabel("needs-replan", t)).toBe("Replan");
  });

  it("passes through non-merge statuses", () => {
    expect(getTaskStatusBadgeLabel("planning", t)).toBe("planning");
    expect(getTaskStatusBadgeLabel("failed", t)).toBe("failed");
    expect(getTaskStatusBadgeLabel(null, t)).toBe("");
  });
});
