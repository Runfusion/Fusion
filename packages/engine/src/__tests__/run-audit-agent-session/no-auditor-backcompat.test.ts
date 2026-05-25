import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAuditEvent, RunAuditEventFilter, RunAuditEventInput, TaskStore } from "@fusion/core";
import { MOCK_PROVIDER_ID } from "@fusion/core";
import { createResolvedAgentSession } from "../../agent-session-helpers.js";

// Existing FN-5544 helper-level no-op coverage lives in agent-session-helpers.test.ts
// FN-5556 extends at store integration seam by asserting no rows + silent no-auditor path.

describe("FN-5556 no-auditor backward compatibility", () => {
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

  it("resolves session and records zero runtime-resolved rows when runAuditor is omitted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const withAuditor = await createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/project",
      systemPrompt: "system",
      defaultProvider: MOCK_PROVIDER_ID,
      defaultModelId: "mock-scripted",
      runAuditor: {
        database: vi.fn(async (input: { type: string; target: string; metadata?: Record<string, unknown> }) => {
          await store.recordRunAuditEvent?.({
            runId: "fn-5556-backcompat",
            agentId: "executor",
            taskId: "FN-5556",
            domain: "database",
            mutationType: input.type,
            target: input.target,
            metadata: input.metadata,
          } as RunAuditEventInput);
        }),
      } as any,
    });

    events = [];
    const withoutAuditor = await createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/project",
      systemPrompt: "system",
      defaultProvider: MOCK_PROVIDER_ID,
      defaultModelId: "mock-scripted",
    });

    const auditRows = store.getRunAuditEvents({ mutationType: "session:runtime-resolved" });
    expect(auditRows).toHaveLength(0);
    expect(withoutAuditor.runtimeId).toBe(withAuditor.runtimeId);
    expect(withoutAuditor.wasConfigured).toBe(withAuditor.wasConfigured);
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes("failed to record session:runtime-resolved audit"))).toBe(false);

    warnSpy.mockRestore();
  });
});
