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
    // FNXC:IssueImportAttachments 2026-07-15-13:40: GitLab import downloads issue/note screenshots into task attachments.
    addAttachment: vi.fn().mockResolvedValue(undefined),
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

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-21:55:
  THE INVARIANT: an import names no column, so the card enters the workflow's OWN intake lane.

  This route passed `column: "triage"`. U11 deleted `triage` — the default board's lanes are
  `todo | in-progress | in-review | done | archived` — and an explicit `column` OVERRIDES the intake
  column `createTask` resolves for the workflow it selects. So every GitLab import wrote its row into
  a lane no workflow declares. Nothing rejects it and nothing logs it: the route answers 201 with a
  task id and the card is simply not on the board.

  Asserted as ABSENCE rather than as a resolved id on purpose — the store here is a fake whose
  `createTask` echoes its input, so a resolved value would be testing the fake. Absence is exactly
  the property that hands the decision to the real `createTask`, and it is what fails on revert.
  */
  it("imports without naming a column, so createTask resolves the workflow's intake lane", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ id: 9, iid: 9, project_id: 3, title: "Lane", description: "Body", web_url: "https://gitlab.example.com/g/p/-/issues/9", state: "opened", labels: [] })));
    const { app, store } = buildApp(fetchImpl);

    const res = await request(app, "POST", "/api/gitlab/project/issues/import", JSON.stringify({ project: 3, iid: 9 }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    const created = store.createTask.mock.calls[0][0];
    expect(created.column).toBeUndefined();
    expect(Object.keys(created)).not.toContain("column");
  });

  /*
  FNXC:IssueImportAttachments 2026-07-15-13:40:
  GitLab imports must hand the agent the same `.fusion/tasks/<id>/attachments/` contract as GitHub imports — the agent-facing behavior cannot depend on which forge the issue came from.
  Covers both image sources (description + notes) and the project-relative `/uploads/` resolution that is the easy thing to get wrong.
  */
  it("downloads description and note images into task attachments", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const imageUrls: string[] = [];
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/notes")) {
        return Promise.resolve(jsonResponse([{ body: "also ![n](/uploads/note1/note.png)" }]));
      }
      if (String(url).includes("/uploads/")) {
        imageUrls.push(String(url));
        return Promise.resolve(
          new Response(png, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(png.length) } }),
        );
      }
      return Promise.resolve(jsonResponse({
        id: 1, iid: 2, project_id: 3, title: "Bug",
        description: "repro ![d](/uploads/desc1/desc.png)",
        web_url: "https://gitlab.example.com/g/p/-/issues/2", state: "opened", labels: [],
      }));
    });

    const { app, store } = buildApp(fetchImpl);
    const res = await request(app, "POST", "/api/gitlab/project/issues/import", JSON.stringify({ project: 3, iid: 2 }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    // /uploads/... is project-rooted, NOT instance-rooted.
    expect(imageUrls).toEqual([
      "https://gitlab.example.com/g/p/uploads/desc1/desc.png",
      "https://gitlab.example.com/g/p/uploads/note1/note.png",
    ]);
    expect(store.addAttachment).toHaveBeenCalledTimes(2);
    expect(store.addAttachment.mock.calls[0]).toEqual(["FN-001", "desc.png", expect.any(Buffer), "image/png"]);
    expect(store.addAttachment.mock.calls[1]).toEqual(["FN-001", "note.png", expect.any(Buffer), "image/png"]);
  });

  it("imports the issue even when notes cannot be fetched", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/notes")) return Promise.resolve(jsonResponse({ message: "403 Forbidden" }, 403));
      return Promise.resolve(jsonResponse({
        id: 1, iid: 2, project_id: 3, title: "Bug", description: "no images",
        web_url: "https://gitlab.example.com/g/p/-/issues/2", state: "opened", labels: [],
      }));
    });

    const { app, store } = buildApp(fetchImpl);
    const res = await request(app, "POST", "/api/gitlab/project/issues/import", JSON.stringify({ project: 3, iid: 2 }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    expect(store.addAttachment).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("imports group issues from selected row and merge requests with IID/branch metadata", async () => {
    // A Response body is single-use, so build a fresh one per call (mockResolvedValue would hand the
    // same consumed instance to the second request). Matches the project-issue import test above.
    const { app, store } = buildApp(vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ id: 9, iid: 5, project_id: 4, title: "MR", description: null, web_url: "https://gitlab.example.com/g/p/-/merge_requests/5", state: "opened", labels: ["review"], source_branch: "feat", target_branch: "main" }))));
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
