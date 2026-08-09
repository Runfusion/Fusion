// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import express from "express";
import { setTaskCreatedHook, type Task, type TaskStore } from "@fusion/core";
import { registerPlanningSubtaskRoutes } from "../routes/register-planning-subtask-routes.js";
import { registerGithubTrackingHook } from "../github-tracking-hook.js";
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
  sourceIssue?: {
    provider: "github";
    repository: string;
    externalIssueId: string;
    issueNumber: number;
    url: string;
    title?: string;
  };
};

const sessions = new Map<string, PlanningSession>();

vi.mock("../planning.js", () => ({
  getSession: (id: string) => sessions.get(id),
  getSummary: (id: string) => sessions.get(id)?.summary,
  releaseSession: vi.fn(),
  cleanupSession: vi.fn(),
  formatInterviewQA: vi.fn(() => ""),
  mergePlanningSubtaskDrafts: vi.fn((_sessionId: string, subtasks: unknown[]) => subtasks),
  /*
  FNXC:PlanningRouteTests 2026-08-04-06:29:
  This direct registrar fixture replaces the whole planning module, so it must expose every
  create-route contract the production dynamic imports consume. Missing task-handoff formatting
  turned otherwise valid single and multi-task GitHub tracking requests into synchronous HTTP 500s;
  retain the epoch-advance seam too so repeated-create and stale-link branches match production.
  */
  updatePlanningCreateClaim: vi.fn(async () => undefined),
  getDurablePlanningSession: vi.fn(async (id: string) => sessions.get(id)),
  claimPlanningTaskCreation: vi.fn(async (id: string) => sessions.get(id)),
  finalizePlanningTaskCreation: vi.fn(async () => undefined),
  reconcilePlanningTaskCreation: vi.fn(async () => undefined),
  releasePlanningTaskCreation: vi.fn(async () => undefined),
  advancePlanningTaskCreationEpoch: vi.fn(async (id: string) => sessions.get(id)),
  formatPlanningTaskHandoff: vi.fn((summary: { description: string }) => summary.description.trim()),
  // FNXC:PlanningMode 2026-07-23-12:10: create-task terminalizes the session after creation.
  validateSession: vi.fn(async () => undefined),
  // FNXC:PlanningMultiTask 2026-07-24-00:20: create-task derives an epoch-scoped proposalClaimId.
  planningProposalClaimId: (sessionId: string, epoch?: number) =>
    epoch && epoch > 0 ? `planning-session:${sessionId}#${epoch}` : `planning-session:${sessionId}`,
  createSessionWithAgent: vi.fn(),
  startExistingSession: vi.fn(),
  RateLimitError: class RateLimitError extends Error {},
  rateLimit: vi.fn(),
  resolvePlanningSourceIssue: (session: PlanningSession) => session.sourceIssue
    ? {
        sourceIssue: session.sourceIssue,
        sourceMetadata: {
          issueUrl: session.sourceIssue.url,
          issueNumber: session.sourceIssue.issueNumber,
        },
        markdown: [
          "## Source Issue",
          "",
          `- **Repository:** ${session.sourceIssue.repository}`,
          `- **Issue:** #${session.sourceIssue.issueNumber} — ${session.sourceIssue.title ?? "Issue"}`,
          `- **URL:** ${session.sourceIssue.url}`,
          "",
          "### Original issue description",
          "",
          "Verbatim issue body.",
        ].join("\n"),
      }
    : undefined,
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

/**
 * Deterministic replacement for `vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(n))`.
 *
 * The routes under test dispatch GitHub-issue creation on a fire-and-forget
 * background promise chain (getSettings → maybeCreateTrackingIssue → createIssue
 * / logger.warn), several `await`s deep. Polling for the call with `vi.waitFor`
 * raced that chain under shard CPU contention (failed in-shard once, passed
 * isolated). Instead we make the observable function itself signal: each
 * invocation resolves the next pending deferred, so the test awaits exactly
 * until the background work reaches the function — no timer, no timeout, no
 * poll. The assertion (call count / argument shape) is unchanged and still bites.
 */
function signalOnCall<A extends unknown[], R>(impl: (...args: A) => R) {
  let pending = deferred<void>();
  const calls: A[] = [];
  const wrapped = (...args: A): R => {
    calls.push(args);
    const toResolve = pending;
    pending = deferred<void>();
    toResolve.resolve();
    return impl(...args);
  };
  // Resolves once the wrapped fn has been called at least `n` times.
  const calledTimes = async (n: number): Promise<void> => {
    while (calls.length < n) {
      await pending.promise;
    }
  };
  // Resolves once some invocation's args satisfy the predicate.
  const calledMatching = async (predicate: (args: A) => boolean): Promise<void> => {
    let seen = 0;
    for (;;) {
      while (seen < calls.length) {
        if (predicate(calls[seen]!)) return;
        seen += 1;
      }
      await pending.promise;
    }
  };
  return { wrapped, calledTimes, calledMatching, get calls() { return calls; } };
}

describe("planning routes github tracking background dispatch", () => {
  let app: express.Express;
  let createIssueSpy: MockInstance<typeof GitHubClient.prototype.createIssue>;
  let planningWarn: ReturnType<typeof vi.fn>;
  let warnSignal: ReturnType<typeof signalOnCall<unknown[], void>>;
  let createTaskMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions.clear();
    warnSignal = signalOnCall<unknown[], void>(() => undefined);
    planningWarn = vi.fn(warnSignal.wrapped);

    let idCounter = 1;
    const createdTasks = new Map<string, Record<string, unknown>>();
    let storeRef: TaskStore | undefined;
    const store = {
      createTask: createTaskMock = vi.fn(async (input: { title?: string; description: string; [key: string]: unknown }) => {
        const task = {
          ...input,
          id: `FN-${idCounter++}`,
          column: "triage",
        };
        createdTasks.set(task.id, task);
        // Mirror real TaskStore behavior: fire the task-created hook so the
        // github-tracking hook can dispatch tracking-issue creation in
        // background. Production TaskStore does this internally; the mock
        // must do it explicitly for the routes to exercise the same path.
        const hook = (await import("@fusion/core")).getTaskCreatedHook?.();
        if (hook && storeRef) {
          void hook(task as Task, storeRef);
        }
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
      upsertTaskDocument: vi.fn(async () => undefined),
      logEntry: vi.fn(async () => undefined),
      getTask: vi.fn(async (id: string) => createdTasks.get(id)),
      listTasks: vi.fn(async () => [...createdTasks.values()]),
      getSettings: vi.fn(async () => ({
        githubLinkImportedIssuesToTracking: true,
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
    storeRef = store;

    registerGithubTrackingHook({ logger: { warn: planningWarn, info: vi.fn() } });

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
        parseLastEventId: () => undefined,
        replayBufferedSSE: () => true,
      },
    );

    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const apiError = err as { statusCode?: number };
      res.status(apiError.statusCode ?? 500).json({ error: err instanceof Error ? err.message : String(err) });
    });

    createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue");
    createIssueSpy.mockReset();
  });

  afterEach(() => {
    setTaskCreatedHook(undefined);
  });

  it("validates and forwards structured GitHub source context when planning starts", async () => {
    const planning = await import("../planning.js") as { createSessionWithAgent: ReturnType<typeof vi.fn> };
    planning.createSessionWithAgent.mockResolvedValue("source-session");
    const sourceIssue = {
      provider: "github",
      repository: "owner/repo",
      issueNumber: 42,
      url: "https://github.com/owner/repo/issues/42",
      title: "Imported issue",
      // An image-bearing body with no policy-allowed URL must still mark this as a post-capture session with an explicit empty list.
      imageBodies: ["![foreign](https://example.com/not-ours.png)"],
    };

    const valid = await performRequest(app, "POST", "/planning/start-streaming", JSON.stringify({
      initialPlan: "Plan this imported issue",
      sourceIssue,
    }), { "content-type": "application/json" });
    expect(valid.status, JSON.stringify(valid)).toBe(201);
    expect(planning.createSessionWithAgent).toHaveBeenCalledTimes(1);
    expect(planning.createSessionWithAgent.mock.calls[0]?.at(-1)).toEqual(expect.objectContaining({
      sourceIssue: expect.objectContaining({
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "42",
        issueNumber: 42,
        url: sourceIssue.url,
        imageUrls: [],
      }),
    }));

    const malformed = await performRequest(app, "POST", "/planning/start-streaming", JSON.stringify({
      initialPlan: "Do not start",
      sourceIssue: { ...sourceIssue, url: "https://github.com/owner/repo/pull/42" },
    }), { "content-type": "application/json" });
    expect(malformed.status).toBe(400);
    expect(planning.createSessionWithAgent).toHaveBeenCalledTimes(1);
  });

  it("POST /planning/create-task returns before createIssue resolves", async () => {
    const issueDeferred = deferred<{ number: number; htmlUrl: string; createdAt: string }>();
    const createIssue = signalOnCall(() => issueDeferred.promise as never);
    createIssueSpy.mockImplementation(createIssue.wrapped);

    sessions.set("plan-1", {
      // FNXC:PlanningMode 2026-07-19-01:45: FN-8341 create-task requires validated sessions.
      validated: true,
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
    await createIssue.calledTimes(1);
    expect(createIssueSpy).toHaveBeenCalledTimes(1);

    issueDeferred.resolve({
      number: 1,
      htmlUrl: "https://github.com/o/r/issues/1",
      createdAt: new Date().toISOString(),
    });

    // No further dispatch should occur after the single createIssue resolves.
    await Promise.resolve();
    expect(createIssueSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves canonical GitHub source provenance and issue context on a planned task", async () => {
    sessions.set("github-plan", {
      validated: true,
      summary: {
        title: "Planned GitHub task",
        description: "Planned task description",
        suggestedSize: "M",
        priority: "normal",
        suggestedDependencies: [],
        keyDeliverables: [],
      },
      initialPlan: "canonical seed",
      history: [],
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "42",
        issueNumber: 42,
        url: "https://github.com/owner/repo/issues/42",
        title: "Original issue",
      },
    });

    const response = await performRequest(
      app,
      "POST",
      "/planning/create-task",
      JSON.stringify({ sessionId: "github-plan" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceIssue: expect.objectContaining({ provider: "github", repository: "owner/repo", issueNumber: 42 }),
      source: { sourceType: "github_import", sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/42", issueNumber: 42 } },
      githubTracking: { enabled: true },
      description: expect.stringContaining("## Source Issue\n\n- **Repository:** owner/repo"),
    }));
    expect(createTaskMock.mock.calls[0]?.[0]?.description).toContain("Verbatim issue body.");
  });

  it("POST /planning/create-task still returns 201 when createIssue rejects", async () => {
    createIssueSpy.mockRejectedValue(new Error("github down"));

    sessions.set("plan-2", {
      // FNXC:PlanningMode 2026-07-19-01:45: FN-8341 create-task requires validated sessions.
      validated: true,
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
    await warnSignal.calledMatching(
      (args) => typeof args[0] === "string" && args[0].includes("[github-tracking] Failed to create issue"),
    );
    expect(planningWarn).toHaveBeenCalledWith(expect.stringContaining("[github-tracking] Failed to create issue"));
  });

  it("POST /planning/create-task still returns 201 when createIssue throws synchronously", async () => {
    createIssueSpy.mockImplementation(() => {
      throw new Error("sync github crash");
    });

    sessions.set("plan-2-sync", {
      // FNXC:PlanningMode 2026-07-19-01:45: FN-8341 create-task requires validated sessions.
      validated: true,
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
      JSON.stringify({ sessionId: "plan-2-sync" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    await warnSignal.calledMatching(
      (args) => typeof args[0] === "string" && args[0].includes("[github-tracking] Failed to create issue"),
    );
    expect(planningWarn).toHaveBeenCalledWith(expect.stringContaining("[github-tracking] Failed to create issue"));
  });

  it("POST /planning/create-tasks dispatches one createIssue per task without blocking", async () => {
    const issueDeferred = deferred<{ number: number; htmlUrl: string; createdAt: string }>();
    const createIssue = signalOnCall(() => issueDeferred.promise as never);
    createIssueSpy.mockImplementation(createIssue.wrapped);

    sessions.set("plan-3", {
      // FNXC:PlanningMode 2026-07-19-01:45: FN-8341 create-task requires validated sessions.
      validated: true,
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
    await createIssue.calledTimes(2);
    expect(createIssueSpy).toHaveBeenCalledTimes(2);

    issueDeferred.resolve({
      number: 2,
      htmlUrl: "https://github.com/o/r/issues/2",
      createdAt: new Date().toISOString(),
    });

    // No third dispatch after the two issues resolve.
    await Promise.resolve();
    expect(createIssueSpy).toHaveBeenCalledTimes(2);
  });

  it("POST /planning/create-tasks still returns 201 when createIssue rejects asynchronously", async () => {
    createIssueSpy.mockRejectedValue(new Error("github down"));

    sessions.set("plan-3-reject", {
      // FNXC:PlanningMode 2026-07-19-01:45: FN-8341 create-task requires validated sessions.
      validated: true,
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
        planningSessionId: "plan-3-reject",
        subtasks: [
          { id: "tmp-1", title: "Subtask 1", description: "D1" },
          { id: "tmp-2", title: "Subtask 2", description: "D2" },
        ],
      }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    await warnSignal.calledMatching(
      (args) => typeof args[0] === "string" && args[0].includes("[github-tracking] Failed to create issue"),
    );
    expect(planningWarn).toHaveBeenCalledWith(expect.stringContaining("[github-tracking] Failed to create issue"));
  });

  it("POST /planning/create-tasks still returns 201 when createIssue throws synchronously", async () => {
    createIssueSpy.mockImplementation(() => {
      throw new Error("sync github crash");
    });

    sessions.set("plan-3-sync", {
      // FNXC:PlanningMode 2026-07-19-01:45: FN-8341 create-task requires validated sessions.
      validated: true,
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
        planningSessionId: "plan-3-sync",
        subtasks: [
          { id: "tmp-1", title: "Subtask 1", description: "D1" },
          { id: "tmp-2", title: "Subtask 2", description: "D2" },
        ],
      }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    await warnSignal.calledMatching(
      (args) => typeof args[0] === "string" && args[0].includes("[github-tracking] Failed to create issue"),
    );
    expect(planningWarn).toHaveBeenCalledWith(expect.stringContaining("[github-tracking] Failed to create issue"));
  });
});
