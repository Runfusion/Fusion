import { describe, expect, it } from "vitest";
import type { AiSessionSummary } from "../../api";
import { dedupeSessionsById } from "../PlanningModeModal";

function makeSession(id: string, updatedAt: string, title = id): AiSessionSummary {
  return {
    id,
    type: "planning",
    status: "complete",
    title,
    projectId: null,
    updatedAt,
    archived: false,
  };
}

describe("dedupeSessionsById", () => {
  it("keeps the most recently updated session for duplicate ids", () => {
    const sessions = [
      makeSession("session-1", "2026-01-01T00:00:00.000Z", "older"),
      makeSession("session-2", "2026-01-03T00:00:00.000Z", "second"),
      makeSession("session-1", "2026-01-04T00:00:00.000Z", "newer"),
    ];

    expect(dedupeSessionsById(sessions)).toEqual([
      makeSession("session-1", "2026-01-04T00:00:00.000Z", "newer"),
      makeSession("session-2", "2026-01-03T00:00:00.000Z", "second"),
    ]);
  });

  it("preserves stable newest-first ordering when timestamps tie", () => {
    const sessions = [
      makeSession("session-a", "2026-01-02T00:00:00.000Z", "first"),
      makeSession("session-b", "2026-01-02T00:00:00.000Z", "second"),
      makeSession("session-a", "2026-01-02T00:00:00.000Z", "ignored duplicate"),
    ];

    expect(dedupeSessionsById(sessions)).toEqual([
      makeSession("session-a", "2026-01-02T00:00:00.000Z", "first"),
      makeSession("session-b", "2026-01-02T00:00:00.000Z", "second"),
    ]);
  });
});
