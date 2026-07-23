import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAuditEvent, RunAuditEventFilter, RunAuditEventInput, TaskStore } from "@fusion/core";
import { createResolvedAgentSession } from "../agents/agent-session-helpers.js";
import { createRunAuditor } from "../util/run-audit.js";
import { MOCK_PROVIDER_ID } from "../providers/mock-provider.js";

const { resolveRuntimeMock } = vi.hoisted(() => ({ resolveRuntimeMock: vi.fn() }));

vi.mock("../execution/runtime-resolution.js", async () => {
  const actual = await vi.importActual<typeof import("../execution/runtime-resolution.js")>("../execution/runtime-resolution.js");
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

  it("warns and audits the runtime built-in fallback when no non-mock model resolves", async () => {
    resolveRuntimeMock.mockResolvedValue({
      runtime: {
        id: "pi",
        name: "pi",
        createSession: vi.fn().mockResolvedValue({ session: { model: { provider: "anthropic", id: "claude-opus-4-8" }, prompt: vi.fn() } }),
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "anthropic/claude-opus-4-8"),
      },
      runtimeId: "pi",
      wasConfigured: false,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auditor = createRunAuditor(store, { runId: "r5", agentId: "a1", taskId: "FN-7787", phase: "execute", source: "executor" });

    await createResolvedAgentSession({ sessionPurpose: "executor", cwd: "/tmp/project", systemPrompt: "system", runAuditor: auditor, settings: {} as any });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("built-in fallback model \"anthropic/claude-opus-4-8\""));
    const events = store.getRunAuditEvents({ mutationType: "session:runtime-resolved" });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual(expect.objectContaining({
      provider: null,
      modelId: null,
      noModelResolved: true,
      runtimeBuiltInFallbackModel: "anthropic/claude-opus-4-8",
    }));
    warnSpy.mockRestore();
  });

  it("does not warn about built-in fallback for mock, test-mode, or fully resolved sessions", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auditor = createRunAuditor(store, { runId: "r6", agentId: "a1", taskId: "FN-7787", phase: "execute", source: "executor" });

    await createResolvedAgentSession({ sessionPurpose: "executor", cwd: "/tmp/project", systemPrompt: "system", defaultProvider: MOCK_PROVIDER_ID, defaultModelId: "scripted", runAuditor: auditor });
    await createResolvedAgentSession({ sessionPurpose: "executor", cwd: "/tmp/project", systemPrompt: "system", runAuditor: auditor, settings: { testMode: true } as any });
    await createResolvedAgentSession({ sessionPurpose: "executor", cwd: "/tmp/project", systemPrompt: "system", defaultProvider: "anthropic", defaultModelId: "claude-fable-5", runAuditor: auditor });

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("no complete provider/model resolved"));
    const events = store.getRunAuditEvents({ mutationType: "session:runtime-resolved" });
    expect(events).toHaveLength(3);
    expect(events.every((event) => !(event.metadata as Record<string, unknown>).noModelResolved)).toBe(true);
    warnSpy.mockRestore();
  });
});
