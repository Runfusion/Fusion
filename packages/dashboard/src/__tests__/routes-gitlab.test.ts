// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerGitLabRoutes } from "../routes/register-gitlab.js";
import { GITLAB_AUTH_HEADER_NAME } from "../gitlab-auth.js";
import type { ApiRoutesContext } from "../routes/types.js";
import { request } from "../test-request.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function buildApp(fetchImpl = vi.fn()) {
  const tasks: any[] = [];
  const store: any = {
    getSettings: vi.fn().mockResolvedValue({ gitlabAuthToken: "token", gitlabInstanceUrl: "https://gitlab.example.com" }),
    getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }),
    listTasks: vi.fn().mockResolvedValue(tasks),
    createTask: vi.fn(async (input) => {
      const task = { id: `FN-${String(tasks.length + 1).padStart(3, "0")}`, ...input, log: [] };
      tasks.push(task);
      return task;
    }),
    logEntry: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  const ctx: ApiRoutesContext = {
    router: express.Router(),
    store,
    runtimeLogger: {} as any,
    planningLogger: {} as any,
    chatLogger: {} as any,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store,
    getProjectContext: async () => ({ store, engine: undefined, projectId: undefined }),
    prioritizeProjectsForCurrentDirectory: (projects) => projects,
    emitRemoteRouteDiagnostic: () => {},
    emitAuthSyncAuditLog: () => {},
    parseScopeParam: () => undefined,
    resolveAutomationStore: () => ({} as any),
    resolveRoutineStore: () => ({} as any),
    resolveRoutineRunner: () => ({} as any),
    registerDispose: () => {},
    dispose: () => {},
    rethrowAsApiError: (error) => { throw error; },
  };
  vi.stubGlobal("fetch", fetchImpl);
  registerGitLabRoutes(ctx);
  app.use("/api", ctx.router);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? err.status ?? 500).json({ error: err.message, ...err.details }));
  return { app, store, tasks, fetchImpl };
}

describe("GitLab import routes", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("fetches project and group issues with encoded path IDs, labels, and token auth", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 1, iid: 2, project_id: 3, title: "Bug", description: null, web_url: "https://gitlab.example.com/g/p/-/issues/2", state: "opened", labels: ["bug"] }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 4, iid: 5, project_id: 6, title: "Group Bug", description: null, web_url: "https://gitlab.example.com/g/p/-/issues/5", state: "opened", labels: ["ops"] }]));
    const { app } = buildApp(fetchImpl);
    const project = await request(app, "POST", "/api/gitlab/project/issues/fetch", JSON.stringify({ project: "g/p", limit: 1, labels: ["bug"] }), { "Content-Type": "application/json" });
    const group = await request(app, "POST", "/api/gitlab/group/issues/fetch", JSON.stringify({ group: "g/sub", labels: "ops,urgent" }), { "Content-Type": "application/json" });
    expect(project.status).toBe(200);
    expect(group.status).toBe(200);
    expect((project.body as any[])[0]).toMatchObject({ resourceKind: "project_issue", iid: 2, labels: ["bug"] });
    expect((group.body as any[])[0]).toMatchObject({ resourceKind: "group_issue", iid: 5, groupPath: "g/sub" });
    expect(fetchImpl.mock.calls[0][0]).toContain("/projects/g%2Fp/issues?");
    expect(fetchImpl.mock.calls[0][0]).toContain("labels=bug");
    expect(fetchImpl.mock.calls[1][0]).toContain("/groups/g%2Fsub/issues?");
    expect(fetchImpl.mock.calls[1][0]).toContain("labels=ops%2Curgent");
    expect(fetchImpl.mock.calls[0][1].headers[GITLAB_AUTH_HEADER_NAME]).toBe("token");
  });

  it("imports project issues with gitlab provenance, tracking defaults, and duplicate protection", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ id: 1, iid: 2, project_id: 3, title: "Bug", description: "Body", web_url: "https://gitlab.example.com/g/p/-/issues/2", state: "opened", labels: ["bug"] })));
    const { app, store } = buildApp(fetchImpl);
    const first = await request(app, "POST", "/api/gitlab/project/issues/import", JSON.stringify({ project: 3, iid: 2 }), { "Content-Type": "application/json" });
    expect(first.status).toBe(201);
    const created = store.createTask.mock.calls[0][0];
    expect(created.source).toMatchObject({ sourceType: "gitlab_import", sourceMetadata: { provider: "gitlab", resourceType: "project_issue", iid: 2, projectId: 3 } });
    expect(created.sourceIssue).toMatchObject({ provider: "gitlab", repository: "g/p", externalIssueId: "1", issueNumber: 2, url: "https://gitlab.example.com/g/p/-/issues/2" });
    expect(created.gitlabTracking.item).toMatchObject({ kind: "project_issue", iid: 2, projectId: 3, projectPath: "g/p", host: "gitlab.example.com" });
    const dup = await request(app, "POST", "/api/gitlab/project/issues/import", JSON.stringify({ project: 3, iid: 2 }), { "Content-Type": "application/json" });
    expect(dup.status).toBe(409);
    expect((dup.body as any).existingTaskId).toBe("FN-001");
  });

  it("imports group issues from selected row and merge requests with IID/branch metadata", async () => {
    const { app, store } = buildApp(vi.fn().mockResolvedValue(jsonResponse({ id: 9, iid: 5, project_id: 4, title: "MR", description: null, web_url: "https://gitlab.example.com/g/p/-/merge_requests/5", state: "opened", labels: ["review"], source_branch: "feat", target_branch: "main" })));
    const group = await request(app, "POST", "/api/gitlab/group/issues/import", JSON.stringify({ group: "g", issue: { resourceKind: "group_issue", id: 2, iid: 7, projectId: 8, projectPath: "g/p", title: "Group", description: null, webUrl: "https://gitlab.example.com/g/p/-/issues/7", state: "opened", labels: [] } }), { "Content-Type": "application/json" });
    expect(group.status).toBe(201);
    expect(store.createTask.mock.calls[0][0].source.sourceMetadata).toMatchObject({ resourceType: "group_issue", groupPath: "g", projectId: 8, issueIid: 7 });
    const mr = await request(app, "POST", "/api/gitlab/merge-requests/import", JSON.stringify({ project: "g/p", iid: 5 }), { "Content-Type": "application/json" });
    expect(mr.status).toBe(201);
    expect(store.createTask.mock.calls[1][0].source.sourceMetadata).toMatchObject({ resourceType: "merge_request", mergeRequestIid: 5, sourceBranch: "feat", targetBranch: "main" });
    expect(store.createTask.mock.calls[1][0].sourceIssue).toMatchObject({ provider: "gitlab", issueNumber: 5, url: "https://gitlab.example.com/g/p/-/merge_requests/5" });
  });


  it("returns a disabled error without fetching GitLab when integration is off", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const { app, store } = buildApp(fetchImpl);
    store.getSettings.mockResolvedValueOnce({ gitlabEnabled: false, gitlabInstanceUrl: "not-a-url", gitlabAuthToken: "" });
    const response = await request(app, "POST", "/api/gitlab/project/issues/fetch", JSON.stringify({ project: "g/p" }), { "Content-Type": "application/json" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("GitLab integration is disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes self-managed settings and returns auth/config errors without token leakage", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const { app, store } = buildApp(fetchImpl);
    store.getSettings.mockResolvedValueOnce({ gitlabAuthToken: "  project-token-value  ", gitlabAuthTokenType: "project", gitlabInstanceUrl: "https://gitlab.example.com/gitlab/" });
    const ok = await request(app, "POST", "/api/gitlab/project/issues/fetch", JSON.stringify({ project: "g/p" }), { "Content-Type": "application/json" });
    expect(ok.status).toBe(200);
    expect(fetchImpl.mock.calls[0][0]).toContain("https://gitlab.example.com/gitlab/api/v4/projects/g%2Fp/issues?");
    expect(fetchImpl.mock.calls[0][1].headers[GITLAB_AUTH_HEADER_NAME]).toBe("project-token-value");

    store.getSettings.mockResolvedValueOnce({ gitlabAuthToken: "secret-token-value", gitlabInstanceUrl: "notaurl" });
    const invalidUrl = await request(app, "POST", "/api/gitlab/project/issues/fetch", JSON.stringify({ project: "g/p" }), { "Content-Type": "application/json" });
    expect(invalidUrl.status).toBe(400);
    expect(JSON.stringify(invalidUrl.body)).not.toContain("secret-token-value");

    store.getSettings.mockResolvedValueOnce({ gitlabAuthToken: "" });
    const missing = await request(app, "POST", "/api/gitlab/project/issues/fetch", JSON.stringify({ project: "g/p" }), { "Content-Type": "application/json" });
    expect(missing.status).toBe(401);
    expect(JSON.stringify(missing.body)).toContain("GitLab auth requires");
    expect(JSON.stringify(missing.body)).not.toContain("token");
  });
});
