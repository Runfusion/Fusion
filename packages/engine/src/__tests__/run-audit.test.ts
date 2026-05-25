import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAuditEvent, RunAuditEventFilter, RunAuditEventInput, TaskStore } from "@fusion/core";
import { MOCK_PROVIDER_ID, isTestModeActive } from "@fusion/core";
import { createResolvedAgentSession } from "../agent-session-helpers.js";
import { createRunAuditor, type DatabaseMutationType, type EngineRunContext, type GitMutationType } from "../run-audit.js";

class AuditStoreStub {
  events: RunAuditEventInput[] = [];
  recordRunAuditEvent(event: RunAuditEventInput): void {
    this.events.push(event);
  }
}

const { resolveRuntimeMock } = vi.hoisted(() => ({ resolveRuntimeMock: vi.fn() }));

vi.mock("../runtime-resolution.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-resolution.js")>("../runtime-resolution.js");
  return { ...actual, resolveRuntime: resolveRuntimeMock };
});

describe("run-audit provisioning mutation types", () => {
  it("accepts provisioning mutation types and records them", async () => {
    const store = new AuditStoreStub();
    const auditor = createRunAuditor(store as unknown as TaskStore, { runId: "r1", agentId: "a1", taskId: "FN-1" });

    const types: DatabaseMutationType[] = [
      "agent:create:requested",
      "agent:create:approved",
      "agent:create:denied",
      "agent:delete:requested",
      "agent:delete:approved",
      "agent:delete:denied",
    ];

    for (const type of types) {
      await auditor.database({ type, target: "agent-x" });
    }

    expect(store.events.map((event) => event.mutationType)).toEqual(types);
  });

  it("accepts integration-worktree merge git mutation types", async () => {
    const store = new AuditStoreStub();
    const auditor = createRunAuditor(store as unknown as TaskStore, { runId: "r1", agentId: "a1", taskId: "FN-1" });

    await auditor.git({
      type: "merge:integration-worktree-state",
      target: "main",
      metadata: {
        taskId: "FN-1",
        integrationBranch: "main",
        integrationMode: "reuse-task-worktree",
        integrationRootDir: "/repo",
        taskWorktreePath: "/repo/.worktrees/fn-1",
        userCheckout: {
          worktreePath: "/repo",
          dirty: true,
          untrackedCount: 1,
          dirtyPathSample: ["README.md"],
        },
        dirtyFingerprint: "abc123",
      },
    });
    await auditor.git({
      type: "merge:cwd-integration-fallback-refused",
      target: "main",
      metadata: {
        taskId: "FN-1",
        integrationBranch: "main",
        refusedGate: "working-tree-dirty",
        refusedReason: "worktree has local changes",
        requestedMode: "reuse-task-worktree",
        taskWorktreePath: "/repo/.worktrees/fn-1",
        parkOutcome: "in-review-failed",
      },
    });
    await auditor.git({
      type: "merge:integration-ref-advance",
      target: "main",
      metadata: {
        taskId: "FN-1",
        integrationBranch: "main",
        refName: "refs/heads/main",
        fromSha: "1111111",
        toSha: "2222222",
        advanceMode: "fast-forward",
        succeeded: true,
      },
    });

    expect(store.events).toHaveLength(3);
    expect(store.events.map((event) => event.domain)).toEqual(["git", "git", "git"]);
    expect(store.events.map((event) => event.mutationType)).toEqual([
      "merge:integration-worktree-state",
      "merge:cwd-integration-fallback-refused",
      "merge:integration-ref-advance",
    ]);
  });

  it("accepts pull:fast-forward metadata shape", async () => {
    const store = new AuditStoreStub();
    const auditor = createRunAuditor(store as unknown as TaskStore, { runId: "r1", agentId: "a1", taskId: "FN-5419" });

    const type: GitMutationType = "pull:fast-forward";
    await auditor.git({
      type,
      target: "/repo/.worktrees/integration",
      metadata: {
        taskId: "FN-5419",
        worktreePath: "/repo/.worktrees/integration",
        integrationBranch: "main",
        remote: "origin",
        fromSha: "1111111",
        toSha: "2222222",
        durationMs: 12,
        succeeded: true,
        behind: 0,
        ahead: 0,
      },
    });

    expect(store.events[0]?.mutationType).toBe(type);
  });

  it("accepts stash:pop-conflict metadata shape", async () => {
    const store = new AuditStoreStub();
    const auditor = createRunAuditor(store as unknown as TaskStore, { runId: "r1", agentId: "a1", taskId: "FN-5419" });

    const type: GitMutationType = "stash:pop-conflict";
    await auditor.git({
      type,
      target: "/repo/.worktrees/integration",
      metadata: {
        taskId: "FN-5419",
        worktreePath: "/repo/.worktrees/integration",
        stashSha: "abc123",
        stashLabel: "fusion-autostash-FN-5419",
        conflictedFiles: ["README.md"],
        autostashOutcome: "conflict-needs-manual",
        advice: "Resolve conflicts and drop stash when complete",
      },
    });

    expect(store.events[0]?.mutationType).toBe(type);
  });

  it("records merge:scope:auto-widen git events", async () => {
    const store = new AuditStoreStub();
    const auditor = createRunAuditor(store as unknown as TaskStore, { runId: "r1", agentId: "a1", taskId: "FN-5226" });

    await auditor.git({
      type: "merge:scope:auto-widen",
      target: "fusion/fn-5226",
      metadata: {
        taskId: "FN-5226",
        file: "AGENTS.md",
        attribution: "subject-prefix",
        commits: ["abc123"],
      },
    });

    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.mutationType).toBe("merge:scope:auto-widen");
    expect(store.events[0]?.metadata).toEqual({
      taskId: "FN-5226",
      file: "AGENTS.md",
      attribution: "subject-prefix",
      commits: ["abc123"],
    });
  });
});

describe("FN-5556: session:runtime-resolved regression battery", () => {
  let recordedEvents: RunAuditEvent[] = [];
  let eventCounter = 0;
  let store: TaskStore;

  beforeEach(() => {
    recordedEvents = [];
    eventCounter = 0;
    resolveRuntimeMock.mockReset().mockResolvedValue({
      runtime: {
        id: "pi",
        name: "Default PI Runtime",
        createSession: vi.fn().mockResolvedValue({ session: { prompt: vi.fn() } }),
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(),
      },
      runtimeId: "pi",
      wasConfigured: false,
    });

    store = {
      recordRunAuditEvent: vi.fn(async (input: RunAuditEventInput) => {
        const metadata = input.metadata
          ? Object.fromEntries(Object.entries(input.metadata).filter(([, value]) => value !== undefined))
          : undefined;
        recordedEvents.push({
          ...input,
          id: `audit-${++eventCounter}`,
          timestamp: input.timestamp ?? new Date().toISOString(),
          ...(metadata ? { metadata } : {}),
        });
      }),
      getRunAuditEvents: vi.fn((filter?: RunAuditEventFilter) => {
        const filtered = recordedEvents.filter((event) => {
          if (!filter?.mutationType) return true;
          return event.mutationType === filter.mutationType;
        });
        return filter?.limit ? filtered.slice(0, filter.limit) : filtered;
      }),
    } as unknown as TaskStore;
  });

  const buildContext = (runId: string): EngineRunContext => ({
    runId,
    agentId: "agent-fn-5556",
    taskId: "FN-5556",
    phase: "execute",
    source: "executor",
  });

  it("records explicit mock-provider metadata", async () => {
    const auditor = createRunAuditor(store, buildContext("fn-5556-mock"));

    await createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/project",
      systemPrompt: "system",
      defaultProvider: MOCK_PROVIDER_ID,
      defaultModelId: "mock-scripted",
      runAuditor: auditor,
    });

    const events = store.getRunAuditEvents({ mutationType: "session:runtime-resolved" });
    expect(events).toHaveLength(1);
    const metadata = events[0]?.metadata as Record<string, unknown>;
    expect(events[0]?.target).toBe("mock");
    expect(Object.keys(metadata).sort()).toEqual([
      "mockProviderActive",
      "modelId",
      "phase",
      "provider",
      "runtimeId",
      "sessionPurpose",
      "source",
      "testModeActive",
      "wasConfigured",
    ]);
    expect(metadata.sessionPurpose).toBe("executor");
    expect(metadata.runtimeId).toBe("mock");
    expect(metadata.wasConfigured).toBe(true);
    expect(metadata.provider).toBe(MOCK_PROVIDER_ID);
    expect(metadata.modelId).toBe("mock-scripted");
    expect(metadata.mockProviderActive).toBe(true);
    expect(metadata.testModeActive).toBe(false);
    expect(metadata.phase).toBe("execute");
    expect(metadata.source).toBe("executor");
  });

  it("records real-provider metadata with non-mock runtime resolution", async () => {
    const auditor = createRunAuditor(store, buildContext("fn-5556-real"));

    await createResolvedAgentSession({
      sessionPurpose: "reviewer",
      cwd: "/tmp/project",
      systemPrompt: "system",
      runtimeHint: "pi",
      defaultProvider: "openai-test-stub",
      defaultModelId: "gpt-4.1-test",
      runAuditor: auditor,
    });

    const events = store.getRunAuditEvents({ mutationType: "session:runtime-resolved" });
    expect(events).toHaveLength(1);
    const metadata = events[0]?.metadata as Record<string, unknown>;
    expect(events[0]?.target).toBe("pi");
    expect(Object.keys(metadata).sort()).toEqual([
      "mockProviderActive",
      "modelId",
      "phase",
      "provider",
      "runtimeHint",
      "runtimeId",
      "sessionPurpose",
      "source",
      "testModeActive",
      "wasConfigured",
    ]);
    expect(metadata.sessionPurpose).toBe("reviewer");
    expect(metadata.runtimeId).toBe("pi");
    expect(metadata.wasConfigured).toBe(false);
    expect(metadata.provider).toBe("openai-test-stub");
    expect(metadata.modelId).toBe("gpt-4.1-test");
    expect(metadata.mockProviderActive).toBe(false);
    expect(metadata.testModeActive).toBe(false);
    expect(metadata.runtimeHint).toBe("pi");
    expect(metadata.phase).toBe("execute");
    expect(metadata.source).toBe("executor");
  });

  it("records testMode activation even with a non-mock configured provider", async () => {
    const auditor = createRunAuditor(store, buildContext("fn-5556-test-mode"));
    const settings = {
      testMode: true,
      defaultProvider: "openai-test-stub",
      defaultModelId: "gpt-4.1-test",
    };
    expect(isTestModeActive(settings)).toBe(true);

    await createResolvedAgentSession({
      sessionPurpose: "heartbeat",
      cwd: "/tmp/project",
      systemPrompt: "system",
      runtimeHint: "pi",
      defaultProvider: "openai-test-stub",
      defaultModelId: "gpt-4.1-test",
      runAuditor: auditor,
      settings: settings as any,
    });

    const events = store.getRunAuditEvents({ mutationType: "session:runtime-resolved" });
    expect(events).toHaveLength(1);
    const metadata = events[0]?.metadata as Record<string, unknown>;
    expect(metadata.provider).toBe("openai-test-stub");
    expect(metadata.modelId).toBe("gpt-4.1-test");
    expect(metadata.testModeActive).toBe(true);
    expect(metadata.mockProviderActive).toBe(false);
  });
});
