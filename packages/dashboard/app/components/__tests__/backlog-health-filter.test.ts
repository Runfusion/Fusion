import { describe, expect, it } from "vitest";

import {
  BACKLOG_HEALTH_TITLE_PREFIXES,
  isBacklogHealthInsight,
} from "../backlog-health-filter";

describe("isBacklogHealthInsight", () => {
  it.each([
    "Backlog health: foo",
    "Backlog pressure detected 2026-05-18",
    "Stale paused todo surfaced [stale-paused-todo]: …",
    "Backlog health: dependency-blocked todos 2026-05-18",
  ])("matches backlog-health prefix: %s", (title) => {
    expect(isBacklogHealthInsight({ title })).toBe(true);
  });

  it.each([
    "backlog health: lowercase",
    "Some other insight",
    "",
  ])("does not match non-prefixed title: %s", (title) => {
    expect(isBacklogHealthInsight({ title })).toBe(false);
  });
});

describe("BACKLOG_HEALTH_TITLE_PREFIXES", () => {
  it("exports a non-empty readonly string array", () => {
    expect(Array.isArray(BACKLOG_HEALTH_TITLE_PREFIXES)).toBe(true);
    expect(BACKLOG_HEALTH_TITLE_PREFIXES.length).toBeGreaterThan(0);
    expect(BACKLOG_HEALTH_TITLE_PREFIXES.every((prefix) => typeof prefix === "string")).toBe(true);
  });
});
