import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAuditEvent, RunAuditEventFilter, RunAuditEventInput, TaskStore } from "@fusion/core";
import { MOCK_PROVIDER_ID } from "@fusion/core";
import { createResolvedAgentSession } from "../../agent-session-helpers.js";
import { createRunAuditor } from "../../run-audit.js";

// Existing FN-5544 coverage references:
// - run-audit-session-runtime-resolved.test.ts: mock/non-mock/no-auditor/metadata round-trip
// - agent-session-helpers.test.ts: helper emits, omitted-auditor success, auditor-throw warning
// FN-5556 call-site guard: packages/engine/src/reviewer.ts:513

describe("FN-5556 reviewer emits session:runtime-resolved", () => {
  let store: TaskStore;
  let events: RunAuditEvent[] = [];
  beforeEach(() => {
    events = [];
    store = {
      recordRunAuditEvent: vi.fn(async (input: RunAuditEventInput) => {
        events.push({ ...input, id: `audit-${events.length + 1}`, timestamp: input.timestamp ?? new Date().toISOString() });
      }),
      getRunAuditEvents: vi.fn((filter?: RunAuditEventFilter) =>
        events.filter((event) => !filter?.mutationType || event.mutationType === filter.mutationType)),
    } as unknown as TaskStore;
  });

  it("records reviewer-purpose runtime resolution event", async () => {
    const auditor = createRunAuditor(store, { runId: "fn-5556-reviewer", agentId: "reviewer", taskId: "FN-5556", phase: "review", source: "reviewer" });
    await createResolvedAgentSession({
      sessionPurpose: "reviewer",
      cwd: "/tmp/project",
      systemPrompt: "system",
      defaultProvider: MOCK_PROVIDER_ID,
      defaultModelId: "mock-scripted",
      runAuditor: auditor,
    });

    const auditRows = store.getRunAuditEvents({ mutationType: "session:runtime-resolved" });
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows.some((row) => row.target === "mock" && row.metadata?.sessionPurpose === "reviewer")).toBe(true);
  });
});
