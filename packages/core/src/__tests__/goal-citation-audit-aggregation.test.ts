import { describe, expect, it } from "vitest";
import type { RunAuditEvent } from "../types.js";
import { collectCitedGoalIdsFromAudit } from "../goals/goal-citation-extractor.js";

function event(partial: Partial<RunAuditEvent>): RunAuditEvent {
  return {
    id: "e-1",
    timestamp: new Date().toISOString(),
    agentId: "agent-1",
    runId: "run-1",
    domain: "database",
    mutationType: "task:update",
    target: "task",
    ...partial,
  };
}

describe("collectCitedGoalIdsFromAudit", () => {
  it("returns empty collections for empty events", () => {
    expect(collectCitedGoalIdsFromAudit([])).toEqual({
      injectedGoalIds: [],
      retrievedGoalIds: [],
      citedGoalIds: [],
    });
  });

  it("collects injection goal ids", () => {
    const result = collectCitedGoalIdsFromAudit([
      event({ mutationType: "goal:injection-applied", metadata: { goalIds: ["G-A", "G-B"] } }),
      event({ mutationType: "prompt:goal-injection", metadata: { goalIds: ["G-B", "G-C"] } }),
    ]);
    expect(result).toEqual({
      injectedGoalIds: ["G-A", "G-B", "G-C"],
      retrievedGoalIds: [],
      citedGoalIds: ["G-A", "G-B", "G-C"],
    });
  });

  it("collects retrieval goal ids from metadata, target, and goalId", () => {
    const result = collectCitedGoalIdsFromAudit([
      event({ mutationType: "goal:retrieval-invoked", target: "G-A", metadata: { goalIds: ["G-B"], goalId: "G-C" } }),
      event({ mutationType: "goal:retrieval-invoked", target: "goals", metadata: { goalId: "G-D" } }),
    ]);
    expect(result).toEqual({
      injectedGoalIds: [],
      retrievedGoalIds: ["G-B", "G-A", "G-C", "G-D"],
      citedGoalIds: ["G-B", "G-A", "G-C", "G-D"],
    });
  });

  it("dedupes and ignores malformed/non-goal ids", () => {
    const result = collectCitedGoalIdsFromAudit([
      event({ mutationType: "goal:injection-skipped", metadata: { goalIds: ["G-1", "FN-1", 42, "G-1"] } }),
      event({ mutationType: "goal:retrieval-invoked", target: "goals", metadata: { goalIds: ["G-1", "G-2", "task-1"], goalId: "G-2" } }),
      event({ mutationType: "goal:retrieval-invoked", target: "FN-9", metadata: { goalId: "not-a-goal" } }),
    ]);
    expect(result).toEqual({
      injectedGoalIds: ["G-1"],
      retrievedGoalIds: ["G-1", "G-2"],
      citedGoalIds: ["G-1", "G-2"],
    });
  });
});
