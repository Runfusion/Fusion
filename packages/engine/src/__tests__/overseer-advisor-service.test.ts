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
});
