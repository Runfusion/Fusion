// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { request as performRequest } from "../test-request.js";

const sessions = new Map<string, any>();

vi.mock("../planning.js", () => ({
  getSession: (id: string) => sessions.get(id),
  getSummary: (id: string) => sessions.get(id)?.summary,
  updatePlanningCreateClaim: vi.fn(async () => undefined),
  getDurablePlanningSession: vi.fn(async (id: string) => sessions.get(id)),
  claimPlanningTaskCreation: vi.fn(async (id: string) => sessions.get(id)),
  finalizePlanningTaskCreation: vi.fn(async () => undefined),
  reconcilePlanningTaskCreation: vi.fn(async () => undefined),
  releasePlanningTaskCreation: vi.fn(async () => undefined),
  advancePlanningTaskCreationEpoch: vi.fn(async (id: string) => sessions.get(id)),
  formatPlanningTaskHandoff: vi.fn((summary: { description: string }) => summary.description),
  validateSession: vi.fn(async () => undefined),
  planningProposalClaimId: (sessionId: string) => `planning-session:${sessionId}`,
  resolvePlanningSourceIssue: (session: any) => session.sourceIssue ? {
    sourceIssue: session.sourceIssue,
    sourceMetadata: { issueUrl: session.sourceIssue.url, issueNumber: session.sourceIssue.issueNumber },
    markdown: "## Source Issue\n\n### Original issue description\n\nCaptured body.",
  } : undefined,
  resolvePlanningIssueImageUrls: (session: any) => ({
    urls: session.sourceIssue?.imageUrls ?? [],
    commentsUnavailable: session.sourceIssue?.commentsUnavailable === true,
    droppedBodyCount: session.sourceIssue?.droppedBodyCount ?? 0,
  }),
}));

import { registerPlanningSubtaskRoutes } from "../routes/register-planning-subtask-routes.js";

const imageUrl = (id: string) => `https://github.com/user-attachments/assets/${id}`;

function sourceIssue(overrides: Record<string, unknown> = {}) {
  return {
    provider: "github" as const,
    repository: "owner/repo",
    externalIssueId: "42",
    issueNumber: 42,
    url: "https://github.com/owner/repo/issues/42",
    title: "Screenshot report",
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    validated: true,
    summary: { title: "Planned task", description: "Implement the fix", suggestedSize: "M", priority: "normal", suggestedDependencies: [], keyDeliverables: [] },
    initialPlan: "initial plan",
    history: [],
    ...overrides,
  };
}

function createHarness() {
  const addAttachment = vi.fn(async () => undefined);
  const logEntry = vi.fn(async () => undefined);
  const createTask = vi.fn(async (input: Record<string, unknown>) => ({ ...input, id: "FN-IMAGE-1" }));
  const store = {
    createTask,
    addAttachment,
    logEntry,
    upsertTaskDocument: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => ({ githubLinkImportedIssuesToTracking: false })),
    getRootDir: vi.fn(() => "/tmp/planning-images"),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn(async () => ({})) })),
    listTasks: vi.fn(async () => []),
    getTask: vi.fn(async () => undefined),
  } as unknown as TaskStore;
  const warn = vi.fn();
  const app = express();
  app.use(express.json());
  registerPlanningSubtaskRoutes({
    router: app,
    getProjectContext: async () => ({ store, projectId: "project-images" }),
    planningLogger: { warn, info: vi.fn() },
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never, { store, parseLastEventId: () => undefined, replayBufferedSSE: () => true });
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  return { app, addAttachment, logEntry, warn };
}

describe("planning create-task GitHub image attachments", () => {
  beforeEach(() => {
    sessions.clear();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png" },
    })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("attaches captured issue and comment images without reading GitHub again", async () => {
    const { app, addAttachment, logEntry } = createHarness();
    sessions.set("images", session({ sourceIssue: sourceIssue({ imageUrls: [imageUrl("body"), imageUrl("comment")] }) }));

    const response = await performRequest(app, "POST", "/planning/create-task", JSON.stringify({ sessionId: "images" }), { "content-type": "application/json" });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(addAttachment).toHaveBeenCalledTimes(2);
    expect(logEntry).toHaveBeenCalledWith("FN-IMAGE-1", "Imported 2 image attachments from GitHub issue", "https://github.com/owner/repo/issues/42");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith("https://github.com/user-attachments/assets/"))).toBe(true);
  });

  it("keeps a created task when image download fails and warns for recorded partial capture", async () => {
    const { app, addAttachment, logEntry, warn } = createHarness();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("download failed"); }));
    sessions.set("partial", session({ sourceIssue: sourceIssue({ imageUrls: [imageUrl("body")], commentsUnavailable: true, droppedBodyCount: 2 }) }));

    const response = await performRequest(app, "POST", "/planning/create-task", JSON.stringify({ sessionId: "partial" }), { "content-type": "application/json" });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(addAttachment).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalledWith("FN-IMAGE-1", expect.stringContaining("image attachment"), expect.anything());
    expect(warn).toHaveBeenCalledWith("Planning GitHub image capture was partial", expect.objectContaining({ commentsUnavailable: true, droppedBodyCount: 2 }));
  });
});
