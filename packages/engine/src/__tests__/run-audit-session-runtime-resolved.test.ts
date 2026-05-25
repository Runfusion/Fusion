import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAuditEvent, RunAuditEventFilter, RunAuditEventInput, TaskStore } from "@fusion/core";
import { createResolvedAgentSession } from "../agent-session-helpers.js";
import { createRunAuditor } from "../run-audit.js";
import { MOCK_PROVIDER_ID } from "../providers/mock-provider.js";

const { resolveRuntimeMock } = vi.hoisted(() => ({ resolveRuntimeMock: vi.fn() }));

vi.mock("../runtime-resolution.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-resolution.js")>("../runtime-resolution.js");
  return { ...actual, resolveRuntime: resolveRuntimeMock };
});

/** SessionPurpose canonical set: executor | triage | reviewer | merger | heartbeat | validation */

describe("FN-5544 session:runtime-resolved audit event", () => {
  let recordedEvents: RunAuditEvent[] = [];
  let counter = 0;
  let store: TaskStore;

  beforeEach(() => {
    recordedEvents = [];
    counter = 0;
    resolveRuntimeMock.mockReset().mockResolvedValue({
      runtime: {
        id: "pi",
        name: "pi",
        createSession: vi.fn().mockResolvedValue({ session: { prompt: vi.fn() } }),
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(),
      },
      runtimeId: "pi",
      wasConfigured: false,
    });
    store = {
      recordRunAuditEvent: vi.fn(async (input: RunAuditEventInput) => {
        recordedEvents.push({ ...input, id: `audit-${++counter}`, timestamp: input.timestamp ?? new Date().toISOString() });
      }),
      getRunAuditEvents: vi.fn((filter?: RunAuditEventFilter) => {
        const filtered = recordedEvents.filter((event) => !filter?.mutationType || event.mutationType === filter.mutationType);
        return filter?.limit ? filtered.slice(0, filter.limit) : filtered;
      }),
    } as unknown as TaskStore;
  });

  it("emits mock-provider runtime-resolved event", async () => {
    const auditor = createRunAuditor(store, { runId: "r1", agentId: "a1", taskId: "FN-5544", phase: "execute", source: "executor" });
    await createResolvedAgentSession({ sessionPurpose: "executor", cwd: "/tmp/project", systemPrompt: "system", defaultProvider: MOCK_PROVIDER_ID, defaultModelId: "scripted", runAuditor: auditor });
    const events = store.getRunAuditEvents({ mutationType: "session:runtime-resolved" });
    expect(events).toHaveLength(1);
    expect(events[0]?.target).toBe("mock");
    expect(events[0]?.metadata).toEqual(expect.objectContaining({ sessionPurpose: "executor", runtimeId: "mock", mockProviderActive: true }));
  });

  it("emits non-mock provider metadata", async () => {
    const auditor = createRunAuditor(store, { runId: "r2", agentId: "a1", taskId: "FN-5544", phase: "review", source: "reviewer" });
    await createResolvedAgentSession({ sessionPurpose: "reviewer", cwd: "/tmp/project", systemPrompt: "system", defaultProvider: "openai", defaultModelId: "gpt-4.1", runAuditor: auditor, runtimeHint: "pi" });
    const events = store.getRunAuditEvents({ mutationType: "session:runtime-resolved" });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual(expect.objectContaining({ sessionPurpose: "reviewer", provider: "openai", modelId: "gpt-4.1", mockProviderActive: false }));
  });

  it("records no rows when runAuditor is omitted", async () => {
    await createResolvedAgentSession({ sessionPurpose: "validation", cwd: "/tmp/project", systemPrompt: "system", defaultProvider: MOCK_PROVIDER_ID, defaultModelId: "scripted" });
    const events = store.getRunAuditEvents({ mutationType: "session:runtime-resolved" });
    expect(events).toHaveLength(0);
  });

  it("round-trips metadata through getRunAuditEvents", async () => {
    const auditor = createRunAuditor(store, { runId: "r4", agentId: "a1", taskId: "FN-5544", phase: "heartbeat", source: "heartbeat" });
    await createResolvedAgentSession({ sessionPurpose: "heartbeat", cwd: "/tmp/project", systemPrompt: "system", defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5", runtimeHint: "hermes", runAuditor: auditor, settings: { testMode: true } as any });
    const events = store.getRunAuditEvents({ mutationType: "session:runtime-resolved" });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual(expect.objectContaining({ sessionPurpose: "heartbeat", runtimeHint: "hermes", testModeActive: true }));
  });
});
