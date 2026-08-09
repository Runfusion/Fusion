import { describe, expect, it } from "vitest";
import { sanitizeAgentActivityMetadata } from "../task-store/agent-activity-outbox.js";
import {
  AGENT_ACTIVITY_GENERATED_ID_PATTERNS,
  AGENT_ACTIVITY_METADATA_SCHEMA,
} from "../types/agents/agents.js";

/*
FNXC:AgentActivityStream 2026-08-09-11:50:
The stream is an audit-facing monitoring surface. These checks pin the deny-by-default boundary so a future metadata key cannot become a single-token prose escape hatch.
*/
describe("agent activity metadata hygiene", () => {
  it("drops prose, nested values, wrong types, and unknown keys", () => {
    expect(sanitizeAgentActivityMetadata("task:started", {
      runId: "FailedToAcquireCredentials",
      error: "this must never persist",
      nested: { error: "no" },
    })).toBeNull();
    expect(sanitizeAgentActivityMetadata("workflow:gate-passed", {
      stepId: "fix-the-thing-that-broke",
      attempt: "3",
      unexpected: "agent-deadbeef",
    })).toEqual({ stepId: "custom" });
  });

  it("preserves every terminal workflow status on its emitted gate outcome", () => {
    expect(sanitizeAgentActivityMetadata("workflow:gate-passed", {
      stepId: "code-review", status: "advisory_failure", attempt: 1,
    })).toEqual({ stepId: "code-review", status: "advisory_failure", attempt: 1 });
    expect(sanitizeAgentActivityMetadata("workflow:gate-failed", {
      stepId: "code-review", status: "advisory_failure", attempt: 1,
    })).toEqual({ stepId: "code-review", status: "advisory_failure", attempt: 1 });
  });

  it("rewrites unlisted human-authored enum values and preserves permitted primitives", () => {
    expect(sanitizeAgentActivityMetadata("task:handed-off", {
      reason: "merge-blew-up-retry-later",
      source: "self-healing",
      runId: "self-heal-handoff-FN-8864-1234567890-abcd",
    })).toEqual({ reason: "unlisted", source: "self-healing", runId: "self-heal-handoff-FN-8864-1234567890-abcd" });
    expect(sanitizeAgentActivityMetadata("task:completed", {
      sha: "a".repeat(40), strategy: "direct",
    })).toEqual({ sha: "a".repeat(40), strategy: "direct" });
  });

  it("has only closed metadata kinds and anchored generated identifiers", () => {
    for (const eventSchema of Object.values(AGENT_ACTIVITY_METADATA_SCHEMA)) {
      for (const spec of Object.values(eventSchema)) {
        expect(["enum", "generatedId", "count", "boolean", "sha"]).toContain(spec.kind);
        if (spec.kind === "enum") expect(spec.values).toContain(spec.fallback);
      }
    }
    const prose = ["FailedToAcquireCredentials", "merge-blew-up-retry-later", "fix-the-thing-that-broke", "hello"];
    for (const pattern of AGENT_ACTIVITY_GENERATED_ID_PATTERNS) {
      expect(pattern.source.startsWith("^")).toBe(true);
      expect(pattern.source.endsWith("$")).toBe(true);
      for (const value of prose) expect(pattern.test(value)).toBe(false);
    }
  });
});
