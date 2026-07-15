import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { OverseerAdvisorService, createParsingOverseerAgent } from "../overseer-advisor-service.js";

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-9001",
    title: "t",
    column: "in-progress",
    status: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe("OverseerAdvisorService", () => {
  it("soft-disables when no model and no agent factory", async () => {
    const store = {
      addSteeringComment: vi.fn(),
    };
    const service = new OverseerAdvisorService({
      store,
      resolveLevel: () => "autonomous",
      resolveModel: () => null,
    });
    const ok = await service.ensureTask(baseTask());
    expect(ok).toBe(false);
    expect(store.addSteeringComment).not.toHaveBeenCalled();
  });

  it("stays off when resolveEnabled is false even with model and agent factory", async () => {
    const addSteeringComment = vi.fn(async () => ({}));
    const agentFactory = vi.fn(async () =>
      createParsingOverseerAgent({
        systemPrompt: "x",
        onAdvice: async () => {},
        complete: async () => JSON.stringify({ note: "should not run", severity: "nit" }),
      }),
    );
    const service = new OverseerAdvisorService({
      store: { addSteeringComment },
      resolveEnabled: () => false,
      resolveLevel: () => "autonomous",
      resolveModel: () => ({ provider: "mock", modelId: "scripted" }),
      agentFactory,
    });
    expect(await service.ensureTask(baseTask())).toBe(false);
    expect(agentFactory).not.toHaveBeenCalled();
    expect(addSteeringComment).not.toHaveBeenCalled();
  });

  it("injects concern notes at autonomous and skips content-free phrases", async () => {
    const addSteeringComment = vi.fn(async () => ({}));
    const recordRunAuditEvent = vi.fn((input) => ({
      id: "e1",
      timestamp: new Date().toISOString(),
      domain: "database",
      mutationType: "overseer:intervention",
      target: "FN-9001",
      ...input,
    }));
    const store = {
      addSteeringComment,
      recordRunAuditEvent,
      getRunAuditEvents: () => [],
      getTask: async () => baseTask(),
    };

    const service = new OverseerAdvisorService({
      store,
      resolveLevel: () => "autonomous",
      resolveModel: () => ({ provider: "mock", modelId: "scripted" }),
      agentFactory: async ({ systemPrompt, onAdvice }) =>
        createParsingOverseerAgent({
          systemPrompt,
          onAdvice,
          complete: async (_sys, user) => {
            if (user.includes("noise-only")) return '{"silence":true}';
            return JSON.stringify({
              note: "You are editing dashboard; File Scope is engine only.",
              severity: "concern",
            });
          },
        }),
    });

    const task = baseTask();
    expect(await service.ensureTask(task)).toBe(true);
    await service.onExecutorLogDelta(task.id, [
      { type: "text", text: "Opening packages/dashboard/app/foo.tsx", agent: "executor" },
    ]);

    await vi.waitFor(() => expect(addSteeringComment).toHaveBeenCalled());
    const text = addSteeringComment.mock.calls[0][1] as string;
    expect(text).toContain("[session-advisor]");
    expect(text).toContain("File Scope is engine only");
    expect(text).toContain('severity="concern"');
  });

  it("observe level does not inject steering comments", async () => {
    const addSteeringComment = vi.fn(async () => ({}));
    const store = {
      addSteeringComment,
      recordRunAuditEvent: vi.fn((input) => ({
        id: "e1",
        timestamp: new Date().toISOString(),
        domain: "database",
        mutationType: "overseer:intervention",
        target: "FN-9001",
        ...input,
      })),
      getRunAuditEvents: () => [],
      getTask: async () => baseTask(),
    };

    const service = new OverseerAdvisorService({
      store,
      resolveLevel: () => "observe",
      resolveModel: () => ({ provider: "mock", modelId: "scripted" }),
      agentFactory: async ({ systemPrompt, onAdvice }) =>
        createParsingOverseerAgent({
          systemPrompt,
          onAdvice,
          complete: async () =>
            JSON.stringify({ note: "Consider extracting a helper.", severity: "nit" }),
        }),
    });

    const task = baseTask();
    await service.ensureTask(task);
    await service.onExecutorLogDelta(task.id, [{ type: "text", text: "writing helper", agent: "executor" }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(addSteeringComment).not.toHaveBeenCalled();
  });

  it("withholds inject when task is user-paused", async () => {
    const addSteeringComment = vi.fn(async () => ({}));
    const paused = baseTask({ userPaused: true, paused: true });
    const store = {
      addSteeringComment,
      getTask: async () => paused,
    };

    const service = new OverseerAdvisorService({
      store,
      resolveLevel: () => "autonomous",
      resolveModel: () => ({ provider: "mock", modelId: "scripted" }),
      agentFactory: async ({ systemPrompt, onAdvice }) =>
        createParsingOverseerAgent({
          systemPrompt,
          onAdvice,
          complete: async () => JSON.stringify({ note: "Should not inject", severity: "blocker" }),
        }),
    });

    // ensureTask itself refuses paused tasks
    expect(await service.ensureTask(paused)).toBe(false);
  });

  it("re-resolves level at inject time so mid-session observe flip does not inject", async () => {
    const addSteeringComment = vi.fn(async () => ({}));
    let level: "autonomous" | "observe" = "autonomous";
    const task = baseTask();
    const store = {
      addSteeringComment,
      recordRunAuditEvent: vi.fn((input) => ({
        id: "e1",
        timestamp: new Date().toISOString(),
        domain: "database",
        mutationType: "overseer:intervention",
        target: "FN-9001",
        ...input,
      })),
      getRunAuditEvents: () => [],
      getTask: async () => task,
    };

    const service = new OverseerAdvisorService({
      store,
      resolveLevel: () => level,
      resolveModel: () => ({ provider: "mock", modelId: "scripted" }),
      agentFactory: async ({ systemPrompt, onAdvice }) =>
        createParsingOverseerAgent({
          systemPrompt,
          onAdvice,
          complete: async () =>
            JSON.stringify({ note: "Concrete File Scope concern for level flip.", severity: "concern" }),
        }),
    });

    expect(await service.ensureTask(task)).toBe(true);
    // Operator flips to observe after ensure but before the first advice lands.
    level = "observe";
    await service.onExecutorLogDelta(task.id, [
      { type: "text", text: "Editing wrong package after flip", agent: "executor" },
    ]);
    await vi.waitFor(() => expect(store.recordRunAuditEvent).toHaveBeenCalled());
    expect(addSteeringComment).not.toHaveBeenCalled();
  });

  it("withholds inject when settings autoMerge is false", async () => {
    const addSteeringComment = vi.fn(async () => ({}));
    // autoMerge:false on task is enough for allowsAutoMergeProcessing to withhold.
    const task = baseTask({ autoMerge: false });
    const store = {
      addSteeringComment,
      getTask: async () => task,
    };

    const service = new OverseerAdvisorService({
      store,
      settings: { autoMerge: false },
      resolveLevel: () => "autonomous",
      resolveModel: () => ({ provider: "mock", modelId: "scripted" }),
      agentFactory: async ({ systemPrompt, onAdvice }) =>
        createParsingOverseerAgent({
          systemPrompt,
          onAdvice,
          complete: async () =>
            JSON.stringify({ note: "Should not inject under autoMerge false.", severity: "blocker" }),
        }),
    });

    // ensureTask consults human-control with settings — withhold before runtime starts.
    expect(await service.ensureTask(task)).toBe(false);
    expect(addSteeringComment).not.toHaveBeenCalled();
  });

  it("re-fetches settings at inject time so a live autoMerge flip withholds", async () => {
    const addSteeringComment = vi.fn(async () => ({}));
    const task = baseTask({ autoMerge: undefined });
    let settings = { autoMerge: true as boolean | undefined };
    /*
    FNXC:PlannerOversight 2026-07-14-18:16:
    Prefer vi.waitFor over a fixed setTimeout so the inject-time withhold settles
    without flaky fixed sleeps (CodeRabbit on #2082). Withhold returns before
    emitSteeringSafe, so wait on getSettings (the inject-time re-fetch) rather
    than recordRunAuditEvent.
    */
    const getSettings = vi.fn(async () => settings);
    const store = {
      addSteeringComment,
      getTask: async () => task,
      getSettings,
      recordRunAuditEvent: vi.fn((input) => ({
        id: "e1",
        timestamp: new Date().toISOString(),
        domain: "database",
        mutationType: "overseer:intervention",
        target: "FN-9001",
        ...input,
      })),
      getRunAuditEvents: () => [],
    };

    const service = new OverseerAdvisorService({
      store,
      settings: { autoMerge: true },
      resolveLevel: () => "autonomous",
      resolveModel: () => ({ provider: "mock", modelId: "scripted" }),
      agentFactory: async ({ systemPrompt, onAdvice }) =>
        createParsingOverseerAgent({
          systemPrompt,
          onAdvice,
          complete: async () =>
            JSON.stringify({ note: "Concrete note after settings flip.", severity: "concern" }),
        }),
    });

    expect(await service.ensureTask(task)).toBe(true);
    // Flip project autoMerge off and mark task so allowsAutoMergeProcessing withholds.
    settings = { autoMerge: false };
    Object.assign(task, { autoMerge: false });

    await service.onExecutorLogDelta(task.id, [
      { type: "text", text: "still working after autoMerge flip", agent: "executor" },
    ]);
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(addSteeringComment).not.toHaveBeenCalled();
  });

  it("withholds inject when getSettings fails (fail closed)", async () => {
    /*
    FNXC:PlannerOversight 2026-07-14-18:16:
    Greptile P1 security: a getSettings() throw must not fall back to a stale
    autoMerge:true cache — withhold inject instead.
    */
    const addSteeringComment = vi.fn(async () => ({}));
    const task = baseTask({ autoMerge: undefined });
    const getSettings = vi.fn(async () => {
      throw new Error("settings store unavailable");
    });
    const store = {
      addSteeringComment,
      getTask: async () => task,
      getSettings,
      recordRunAuditEvent: vi.fn((input) => ({
        id: "e1",
        timestamp: new Date().toISOString(),
        domain: "database",
        mutationType: "overseer:intervention",
        target: "FN-9001",
        ...input,
      })),
      getRunAuditEvents: () => [],
    };

    const service = new OverseerAdvisorService({
      store,
      settings: { autoMerge: true },
      resolveLevel: () => "autonomous",
      resolveModel: () => ({ provider: "mock", modelId: "scripted" }),
      agentFactory: async ({ systemPrompt, onAdvice }) =>
        createParsingOverseerAgent({
          systemPrompt,
          onAdvice,
          complete: async () =>
            JSON.stringify({ note: "Must not inject when settings read fails.", severity: "blocker" }),
        }),
    });

    expect(await service.ensureTask(task)).toBe(true);
    await service.onExecutorLogDelta(task.id, [
      { type: "text", text: "working while settings store is down", agent: "executor" },
    ]);
    // Wait until inject-time getSettings ran (then failed closed); no steering inject.
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(addSteeringComment).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("withholds inject when getSettings resolves to undefined (fail closed)", async () => {
    /*
    FNXC:PlannerOversight 2026-07-14-18:25:
    Greptile P1: undefined live settings must not fall back to a stale
    autoMerge:true cache — withhold inject the same as a throw.
    */
    const addSteeringComment = vi.fn(async () => ({}));
    const task = baseTask({ autoMerge: undefined });
    const getSettings = vi.fn(async () => undefined);
    const store = {
      addSteeringComment,
      getTask: async () => task,
      getSettings,
      recordRunAuditEvent: vi.fn((input) => ({
        id: "e1",
        timestamp: new Date().toISOString(),
        domain: "database",
        mutationType: "overseer:intervention",
        target: "FN-9001",
        ...input,
      })),
      getRunAuditEvents: () => [],
    };

    const service = new OverseerAdvisorService({
      store,
      settings: { autoMerge: true },
      resolveLevel: () => "autonomous",
      resolveModel: () => ({ provider: "mock", modelId: "scripted" }),
      agentFactory: async ({ systemPrompt, onAdvice }) =>
        createParsingOverseerAgent({
          systemPrompt,
          onAdvice,
          complete: async () =>
            JSON.stringify({ note: "Must not inject when settings are missing.", severity: "blocker" }),
        }),
    });

    expect(await service.ensureTask(task)).toBe(true);
    await service.onExecutorLogDelta(task.id, [
      { type: "text", text: "working while settings are missing", agent: "executor" },
    ]);
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(addSteeringComment).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });
});
