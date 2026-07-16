import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  createMockApi,
  createPgExtensionHarness,
  pgDescribe,
} from "./pg-extension-harness.js";

const gitlabIssues = vi.hoisted(() => ({
  project: [{ resourceKind: "project_issue", id: 1, iid: 2, projectId: 3, projectPath: "g/p", title: "Project issue", description: "Body", webUrl: "https://gitlab.example.com/g/p/-/issues/2", state: "opened", labels: [] }],
  group: [{ resourceKind: "group_issue", id: 4, iid: 7, projectId: 8, projectPath: "g/p", groupPath: "g", title: "Group issue", description: null, webUrl: "https://gitlab.example.com/g/p/-/issues/7", state: "opened", labels: [] }],
  mrs: [{ resourceKind: "merge_request", id: 5, iid: 9, projectId: 8, projectPath: "g/p", title: "Merge request", description: "MR", webUrl: "https://gitlab.example.com/g/p/-/merge_requests/9", state: "opened", labels: [], sourceBranch: "feat", targetBranch: "main" }],
}));

vi.mock("@fusion/dashboard", () => {
  class GitLabClient {
    auth: any;
    constructor(auth: any) { this.auth = auth; }
    listProjectIssues = vi.fn(async () => gitlabIssues.project);
    listGroupIssues = vi.fn(async () => gitlabIssues.group);
    listMergeRequests = vi.fn(async () => gitlabIssues.mrs);
  }
  return {
    registerGithubTrackingHook: vi.fn(),
    resolveGitlabAuth: vi.fn(({ projectSettings }: any) => projectSettings.gitlabAuthToken
      ? { ok: true, auth: { apiBaseUrl: "https://gitlab.example.com/api/v4", webBaseUrl: "https://gitlab.example.com", token: projectSettings.gitlabAuthToken, tokenType: "personal", headerName: "PRIVATE-TOKEN" } }
      : { ok: false, message: "GitLab auth requires a configured access token" }),
    GitLabClient,
    buildGitLabTaskDescription: (item: any) => `${item.description?.trim() || "(no description)"}\n\nSource: ${item.webUrl}`,
    buildGitLabTaskProvenance: ({ resourceType, item, groupInput }: any) => ({
      sourceIssue: { provider: "gitlab", repository: item.projectPath ?? String(item.projectId), externalIssueId: String(item.id), issueNumber: item.iid, url: item.webUrl },
      gitlabTracking: { item: { kind: resourceType, iid: item.iid, id: item.id, projectId: item.projectId, projectPath: item.projectPath, groupPath: item.groupPath ?? groupInput, url: item.webUrl, host: "gitlab.example.com", instanceUrl: "https://gitlab.example.com", title: item.title, state: item.state } },
      sourceMetadata: { provider: "gitlab", resourceType, iid: item.iid, groupInput, projectPath: item.projectPath, mergeRequestIid: resourceType === "merge_request" ? item.iid : undefined },
    }),
    isGitLabAlreadyImported: (task: any, provenance: any) => task.sourceIssue?.url === provenance.sourceIssue.url,
  };
});

vi.mock("@fusion/engine", () => ({
  installBaselineArchiveWorktreeDisposer: vi.fn(),
  createFnAgent: vi.fn(),
  fetchWebContent: vi.fn(),
  assertNoSecretPlaintext: vi.fn(),
  emitGoalRetrievalAudit: vi.fn(),
  createWorkflowAuthoringTools: vi.fn(() => ({})),
  // FNXC:TestInfrastructure 2026-07-13-10:25: Complete the engine mock for extension.ts named imports (experiment finalize, workflow params, etc.).
  defaultGitOps: {},
  ExperimentFinalizeBranchExistsError: class MockError extends Error {},
  ExperimentFinalizeCherryPickConflictError: class MockError extends Error {},
  ExperimentFinalizeMergeBaseError: class MockError extends Error {},
  ExperimentFinalizeNoKeptRunsError: class MockError extends Error {},
  ExperimentFinalizePlanError: class MockError extends Error {},
  ExperimentFinalizeService: vi.fn(),
  ExperimentFinalizeStateError: class MockError extends Error {},
  isInReviewMissingWorktreeSessionStartFailure: vi.fn(),
  workflowListParams: {},
  workflowGetParams: {},
  workflowSelectParams: {},
  workflowCreateParams: {},
  workflowUpdateParams: {},
  workflowDeleteParams: {},
  workflowValidateParams: {},
  workflowSettingsParams: {},
  traitListParams: {},
  normalizeAgentLogPaging: vi.fn(() => ({ limit: 100, offset: 0 })),
  renderAgentLogEntries: vi.fn(() => ""),
  workflowListParams: {},
  workflowGetParams: {},
  workflowValidateParams: {}, // FNXC:Round10 FN-7911 added this export to @fusion/engine barrel
  workflowSelectParams: {},
  workflowCreateParams: {},
  workflowUpdateParams: {},
  workflowDeleteParams: {},
  workflowSettingsParams: {},
  traitListParams: {},
}));

async function loadExtension() {
  const mod = await import("../extension.js");
  return mod.default;
}

const h = createPgExtensionHarness("fn-8094-gitlab");

async function setupTools() {
  await h.store().updateSettings({ gitlabAuthToken: "glpat_test", gitlabInstanceUrl: "https://gitlab.example.com" });
  const extension = await loadExtension();
  const api = createMockApi();
  extension({
    ...api,
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
  } as any);
  return { cwd: h.rootDir(), tools: api.tools };
}

/*
FNXC:PostgresCutover 2026-07-16-05:40:
This GitLab extension suite runs on the shared PostgreSQL harness instead of the
removed inMemoryDb runtime. Its preserved tracking assertions require FN-8094
rowToTask hydration so imported GitLab provenance survives ordinary store reads.

FNXC:GitLabExtension 2026-07-02-00:00:
GitLab extension tools are HTTP API tools backed by configured GitLab token settings. They must expose project/group/MR schemas, create local GitLab source/tracking metadata, and never depend on a `glab` binary or real network.
*/
pgDescribe("extension GitLab import tools", () => {
  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("registers browse/import tools for project issues, group issues, and merge requests", async () => {
    const { tools } = await setupTools();
    for (const name of [
      "fn_task_browse_gitlab_project_issues",
      "fn_task_import_gitlab_project_issues",
      "fn_task_browse_gitlab_group_issues",
      "fn_task_import_gitlab_group_issues",
      "fn_task_browse_gitlab_merge_requests",
      "fn_task_import_gitlab_merge_requests",
    ]) {
      expect(tools.get(name), name).toBeTruthy();
      expect(JSON.stringify(tools.get(name).parameters)).toContain(name.includes("group") ? "group" : "project");
      expect(tools.get(name).description).toMatch(/GitLab/);
    }
  });

  it("imports GitLab project, group, and MR resources with source and tracking metadata", async () => {
    const { cwd, tools } = await setupTools();
    const project = await tools.get("fn_task_import_gitlab_project_issues").execute("p", { project: "g/p", limit: 1 }, undefined, undefined, { cwd });
    const group = await tools.get("fn_task_import_gitlab_group_issues").execute("g", { group: "g", limit: 1 }, undefined, undefined, { cwd });
    const mr = await tools.get("fn_task_import_gitlab_merge_requests").execute("m", { project: "g/p", limit: 1 }, undefined, undefined, { cwd });

    expect(project.content[0].text).toContain("Imported 1 GitLab project issue tasks");
    expect(group.content[0].text).toContain("Imported 1 GitLab group issue tasks");
    expect(mr.content[0].text).toContain("Imported 1 GitLab merge request tasks");

    const tasks = await h.store().listTasks({ slim: false });
    expect(tasks.map((task) => task.sourceIssue?.provider)).toEqual(["gitlab", "gitlab", "gitlab"]);
    expect(tasks.map((task) => task.gitlabTracking?.item?.kind)).toEqual(["project_issue", "group_issue", "merge_request"]);
    expect(tasks.find((task) => task.gitlabTracking?.item?.kind === "group_issue")?.gitlabTracking?.item?.groupPath).toBe("g");
    expect(tasks.find((task) => task.gitlabTracking?.item?.kind === "merge_request")?.title).toMatch(/^Review MR !9:/);
  });

  it("returns human-readable auth errors without leaking token-like input", async () => {
    const { cwd, tools } = await setupTools();
    await h.store().updateSettings({ gitlabAuthToken: null as any });

    await expect(tools.get("fn_task_browse_gitlab_project_issues").execute("p", { project: "g/p" }, undefined, undefined, { cwd }))
      .resolves.toMatchObject({
        isError: true,
        details: { error: "GitLab auth requires a configured access token" },
      });
  });
});
