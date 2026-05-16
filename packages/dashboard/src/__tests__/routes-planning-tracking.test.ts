// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { registerPlanningSubtaskRoutes } from "../routes/register-planning-subtask-routes.js";
import { request as performRequest } from "../test-request.js";
import { GitHubClient } from "../github.js";

type PlanningSession = {
  summary: {
    title: string;
    description: string;
    suggestedSize: "S" | "M" | "L";
    priority: "normal";
    suggestedDependencies: string[];
    keyDeliverables: string[];
  };
  initialPlan: string;
  history: Array<{ role: string; content: string }>;
};

const sessions = new Map<string, PlanningSession>();

vi.mock("../planning.js", () => ({
  getSession: (id: string) => sessions.get(id),
  getSummary: (id: string) => sessions.get(id)?.summary,
  cleanupSession: vi.fn(),
  formatInterviewQA: vi.fn(() => ""),
  mergePlanningSubtaskDrafts: vi.fn((_sessionId: string, subtasks: unknown[]) => subtasks),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("planning routes github tracking background dispatch", () => {
  let app: express.Express;
  let createIssueSpy: ReturnType<typeof vi.spyOn>;
  let planningWarn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions.clear();
    planningWarn = vi.fn();

    let idCounter = 1;
    const createdTasks = new Map<string, Record<string, unknown>>();
    const store = {
      createTask: vi.fn(async (input: { title?: string; description: string }) => {
        const task = {
          id: `FN-${idCounter++}`,
          title: input.title,
          description: input.description,
          column: "triage",
        };
        createdTasks.set(task.id, task);
        return task;
      }),
      updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const next = { ...(createdTasks.get(id) ?? { id }), ...patch };
        createdTasks.set(id, next);
        return next;
      }),
      updateGithubTracking: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const next = { ...(createdTasks.get(id) ?? { id }), githubTracking: patch };
        createdTasks.set(id, next);
        return next;
      }),
      logEntry: vi.fn(async () => undefined),
      getTask: vi.fn(async (id: string) => createdTasks.get(id)),
      getSettings: vi.fn(async () => ({
        githubTrackingEnabledByDefault: true,
        githubTrackingDefaultRepo: "o/r",
        githubAuthMode: "token",
        githubAuthToken: "test-token",
      })),
      getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn(async () => ({})) })),
      getRootDir: vi.fn(() => "/tmp/project"),
      updateIssueInfo: vi.fn(async () => undefined),
      linkGithubIssue: vi.fn(async () => undefined),
      recordActivity: vi.fn(async () => undefined),
    } as unknown as TaskStore;

    app = express();
    app.use(express.json());

    registerPlanningSubtaskRoutes(
      {
        router: app,
        getProjectContext: async () => ({ store, projectId: "proj-1" }),
        planningLogger: { info: vi.fn(), warn: planningWarn },
        rethrowAsApiError: (err: unknown) => {
          throw err instanceof Error ? err : new Error(String(err));
        },
      } as never,
      {
        store,
        checkSessionLock: () => ({ allowed: true }),
        parseLastEventId: () => undefined,
        replayBufferedSSE: () => true,
      },
    );

    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    });

    createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue");
  });

  it("POST /planning/create-task returns before createIssue resolves", async () => {
    const issueDeferred = deferred<{ number: number; htmlUrl: string; createdAt: string }>();
    createIssueSpy.mockReturnValue(issueDeferred.promise as never);

    sessions.set("plan-1", {
      summary: {
        title: "Planned task",
        description: "Planned task description",
        suggestedSize: "M",
        priority: "normal",
        suggestedDependencies: [],
        keyDeliverables: [],
      },
      initialPlan: "initial",
      history: [],
    });

    const responsePromise = performRequest(
      app,
      "POST",
      "/planning/create-task",
      JSON.stringify({ sessionId: "plan-1" }),
      { "content-type": "application/json" },
    );

    const response = await responsePromise;
    expect(response.status).toBe(201);
    await vi.waitFor(() => {
      expect(createIssueSpy).toHaveBeenCalledTimes(1);
    });

    issueDeferred.resolve({
      number: 1,
      htmlUrl: "https://github.com/o/r/issues/1",
      createdAt: new Date().toISOString(),
    });

    await vi.waitFor(() => {
      expect(createIssueSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("POST /planning/create-task still returns 201 when createIssue rejects", async () => {
    createIssueSpy.mockRejectedValue(new Error("github down"));

    sessions.set("plan-2", {
      summary: {
        title: "Planned task 2",
        description: "Planned task description 2",
        suggestedSize: "M",
        priority: "normal",
        suggestedDependencies: [],
        keyDeliverables: [],
      },
      initialPlan: "initial",
      history: [],
    });

    const response = await performRequest(
      app,
      "POST",
      "/planning/create-task",
      JSON.stringify({ sessionId: "plan-2" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    await vi.waitFor(() => {
      expect(planningWarn).toHaveBeenCalled();
    });
  });

  it("POST /planning/create-tasks dispatches one createIssue per task without blocking", async () => {
    const issueDeferred = deferred<{ number: number; htmlUrl: string; createdAt: string }>();
    createIssueSpy.mockReturnValue(issueDeferred.promise as never);

    sessions.set("plan-3", {
      summary: {
        title: "Plan",
        description: "Plan",
        suggestedSize: "M",
        priority: "normal",
        suggestedDependencies: [],
        keyDeliverables: [],
      },
      initialPlan: "initial",
      history: [],
    });

    const response = await performRequest(
      app,
      "POST",
      "/planning/create-tasks",
      JSON.stringify({
        planningSessionId: "plan-3",
        subtasks: [
          { id: "tmp-1", title: "Subtask 1", description: "D1" },
          { id: "tmp-2", title: "Subtask 2", description: "D2" },
        ],
      }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    await vi.waitFor(() => {
      expect(createIssueSpy).toHaveBeenCalledTimes(2);
    });

    issueDeferred.resolve({
      number: 2,
      htmlUrl: "https://github.com/o/r/issues/2",
      createdAt: new Date().toISOString(),
    });

    await vi.waitFor(() => {
      expect(createIssueSpy).toHaveBeenCalledTimes(2);
    });
  });
});
