import { badRequest, unauthorized, ApiError } from "../api-error.js";
import { resolveGitlabAuth } from "../gitlab-auth.js";
import {
  buildGitLabTaskDescription,
  buildGitLabTaskProvenance,
  GitLabApiError,
  GitLabClient,
  isGitLabAlreadyImported,
  type GitLabIssue,
  type GitLabMergeRequest,
  type GitLabResourceType,
} from "../gitlab.js";
import { GitLabSourceIssueReconciler, GITLAB_RECONCILE_SCAN_LIMIT } from "../gitlab-source-issue-reconciler.js";
import { importIssueImageAttachments, gitlabImagePolicy } from "../issue-image-attachments.js";
import type { ApiRoutesContext } from "./types.js";

function readRequiredString(body: Record<string, unknown>, key: string): string | number {
  const value = body[key];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw badRequest(`${key} is required`);
}

function readPositiveInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw badRequest(`${key} is required and must be a positive integer`);
}

function readLabels(body: Record<string, unknown>): string[] | undefined {
  const labels = body.labels;
  if (Array.isArray(labels)) return labels.filter((label): label is string => typeof label === "string" && label.trim().length > 0);
  if (typeof labels === "string" && labels.trim()) return labels.split(",").map((label) => label.trim()).filter(Boolean);
  return undefined;
}

function readLimit(body: Record<string, unknown>): number | undefined {
  return typeof body.limit === "number" ? body.limit : undefined;
}

function readState(body: Record<string, unknown>): string | undefined {
  return typeof body.state === "string" && body.state.trim() ? body.state.trim() : undefined;
}

function readNonNegativeInteger(body: Record<string, unknown>, key: string, fallback: number): number {
  const value = body[key];
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw badRequest(`${key} must be a non-negative integer`);
}

function readBackfillLimit(body: Record<string, unknown>): number {
  const value = body.limit;
  if (value === undefined) return GITLAB_RECONCILE_SCAN_LIMIT;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return Math.min(value, GITLAB_RECONCILE_SCAN_LIMIT);
  }
  throw badRequest("limit must be a positive integer");
}

async function createClient(ctx: ApiRoutesContext, req: Parameters<ApiRoutesContext["getProjectContext"]>[0]): Promise<GitLabClient> {
  const { store } = await ctx.getProjectContext(req);
  const projectSettings = await store.getSettings();
  const globalSettings = await store.getGlobalSettingsStore().getSettings();
  const auth = resolveGitlabAuth({ projectSettings, globalSettings });
  if (!auth.ok) {
    throw auth.reason === "token_missing" ? unauthorized(auth.message) : badRequest(auth.message);
  }
  return new GitLabClient(auth.auth);
}

function mapGitLabClientError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof GitLabApiError) throw new ApiError(error.status === 401 ? 401 : error.status, error.message);
  throw error;
}

async function findDuplicate(ctx: ApiRoutesContext, req: Parameters<ApiRoutesContext["getProjectContext"]>[0], provenance: ReturnType<typeof buildGitLabTaskProvenance>) {
  const { store } = await ctx.getProjectContext(req);
  const existingTasks = await store.listTasks({ slim: false, includeArchived: false });
  return existingTasks.find((task) => isGitLabAlreadyImported(task, provenance));
}

async function importItem(ctx: ApiRoutesContext, req: Parameters<ApiRoutesContext["getProjectContext"]>[0], args: {
  resourceType: GitLabResourceType;
  item: GitLabIssue | GitLabMergeRequest;
  projectInput?: string | number;
  groupInput?: string | number;
}) {
  const { store } = await ctx.getProjectContext(req);
  const client = await createClient(ctx, req);
  const auth = (client as unknown as { auth: { apiBaseUrl: string; webBaseUrl: string } }).auth;
  const provenance = buildGitLabTaskProvenance({ auth, ...args });
  const duplicate = await findDuplicate(ctx, req, provenance);
  if (duplicate) {
    throw new ApiError(409, `GitLab ${args.resourceType} #${args.item.iid} already imported as ${duplicate.id}`, { existingTaskId: duplicate.id });
  }

  const title = args.resourceType === "merge_request"
    ? `Review MR !${args.item.iid}: ${args.item.title.slice(0, 180)}`
    : args.item.title.slice(0, 200);
  const task = await store.createTask({
    title: title || undefined,
    description: buildGitLabTaskDescription(args.item),
    column: "triage",
    dependencies: [],
    sourceIssue: provenance.sourceIssue,
    gitlabTracking: provenance.gitlabTracking,
    source: { sourceType: "gitlab_import", sourceMetadata: provenance.sourceMetadata },
  });
  await store.logEntry(task.id, args.resourceType === "merge_request" ? "Imported merge request from GitLab" : "Imported from GitLab", args.item.webUrl);

  /*
  FNXC:IssueImportAttachments 2026-07-15-13:40:
  GitLab imports attach their screenshots exactly like GitHub imports: the agent-facing contract is `.fusion/tasks/<id>/attachments/`, and it must not depend on which forge the issue came from. All four GitLab import routes (project issue, group issue, MR, batch) funnel through importItem, so wiring here covers every surface.
  GitLab `/uploads/...` assets need the instance token, which only exists here — see gitlabImagePolicy for why resolution is project-relative.
  Best-effort: notes-fetch and download failures never fail an import that already produced the task.
  */
  const gitlabAuth = (client as unknown as { auth: { webBaseUrl: string; token: string; headerName: string } }).auth;
  const imageBodies: Array<string | null | undefined> = [args.item.description];
  const noteResource = args.resourceType === "merge_request" ? "merge_requests" as const : "issues" as const;
  const noteProject = args.item.projectPath ?? args.item.projectId;
  if (noteProject !== undefined) {
    try {
      imageBodies.push(...(await client.listNotes(noteResource, noteProject, args.item.iid)));
    } catch (error) {
      console.warn(
        `[fusion:gitlab-import] Could not fetch notes for ${args.resourceType} #${args.item.iid}; importing description images only: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const imageImport = await importIssueImageAttachments(
    store,
    task.id,
    imageBodies,
    gitlabImagePolicy({
      webBaseUrl: gitlabAuth.webBaseUrl,
      webUrl: args.item.webUrl,
      token: gitlabAuth.token,
      headerName: gitlabAuth.headerName,
    }),
  );
  if (imageImport.attached > 0) {
    await store.logEntry(
      task.id,
      `Imported ${imageImport.attached} image attachment${imageImport.attached === 1 ? "" : "s"} from GitLab`,
      args.item.webUrl,
    );
  }

  return task;
}

export function registerGitLabRoutes(ctx: ApiRoutesContext): void {
  const { router, rethrowAsApiError } = ctx;

  router.post("/git/gitlab/backfill-source-issue-closed-at", async (req, res) => {
    try {
      const { store } = await ctx.getProjectContext(req);
      const offset = readNonNegativeInteger(req.body ?? {}, "offset", 0);
      const limit = readBackfillLimit(req.body ?? {});
      const result = await new GitLabSourceIssueReconciler().backfillSourceIssueClosedAt(store, { offset, limit });
      res.json(result);
    } catch (error) {
      rethrowAsApiError(error);
    }
  });

  router.post("/gitlab/project/issues/fetch", async (req, res) => {
    try {
      const project = readRequiredString(req.body, "project");
      const client = await createClient(ctx, req);
      res.json(await client.listProjectIssues(project, { limit: readLimit(req.body), labels: readLabels(req.body), state: readState(req.body) }));
    } catch (error) {
      try { mapGitLabClientError(error); } catch (mapped) { rethrowAsApiError(mapped); }
    }
  });

  router.post("/gitlab/group/issues/fetch", async (req, res) => {
    try {
      const group = readRequiredString(req.body, "group");
      const client = await createClient(ctx, req);
      res.json(await client.listGroupIssues(group, { limit: readLimit(req.body), labels: readLabels(req.body), state: readState(req.body) }));
    } catch (error) {
      try { mapGitLabClientError(error); } catch (mapped) { rethrowAsApiError(mapped); }
    }
  });

  router.post("/gitlab/merge-requests/fetch", async (req, res) => {
    try {
      const project = readRequiredString(req.body, "project");
      const client = await createClient(ctx, req);
      res.json(await client.listMergeRequests(project, { limit: readLimit(req.body), labels: readLabels(req.body), state: readState(req.body) }));
    } catch (error) {
      try { mapGitLabClientError(error); } catch (mapped) { rethrowAsApiError(mapped); }
    }
  });

  router.post("/gitlab/project/issues/import", async (req, res) => {
    try {
      const project = readRequiredString(req.body, "project");
      const iid = readPositiveInteger(req.body, "iid");
      const client = await createClient(ctx, req);
      const item = await client.getProjectIssue(project, iid);
      res.status(201).json(await importItem(ctx, req, { resourceType: "project_issue", item, projectInput: project }));
    } catch (error) {
      try { mapGitLabClientError(error); } catch (mapped) { rethrowAsApiError(mapped); }
    }
  });

  router.post("/gitlab/group/issues/import", async (req, res) => {
    try {
      const item = req.body.issue as GitLabIssue | undefined;
      const group = typeof req.body.group !== "undefined" ? readRequiredString(req.body, "group") : undefined;
      if (!item || typeof item !== "object" || typeof item.iid !== "number" || typeof item.webUrl !== "string") {
        throw badRequest("issue is required");
      }
      res.status(201).json(await importItem(ctx, req, { resourceType: "group_issue", item: { ...item, resourceKind: "group_issue" }, groupInput: group }));
    } catch (error) {
      try { mapGitLabClientError(error); } catch (mapped) { rethrowAsApiError(mapped); }
    }
  });

  router.post("/gitlab/merge-requests/import", async (req, res) => {
    try {
      const project = readRequiredString(req.body, "project");
      const iid = readPositiveInteger(req.body, "iid");
      const client = await createClient(ctx, req);
      const item = await client.getMergeRequest(project, iid);
      res.status(201).json(await importItem(ctx, req, { resourceType: "merge_request", item, projectInput: project }));
    } catch (error) {
      try { mapGitLabClientError(error); } catch (mapped) { rethrowAsApiError(mapped); }
    }
  });

  router.post("/gitlab/batch-import", async (req, res) => {
    try {
      const items = Array.isArray(req.body.items) ? req.body.items : [];
      if (items.length === 0 || items.length > 50) throw badRequest("items must contain 1 to 50 resources");
      const results = [];
      for (const item of items) {
        try {
          const resourceType = item.resourceType as GitLabResourceType;
          if (resourceType === "project_issue") {
            results.push({ success: true, taskId: (await importItem(ctx, req, { resourceType, item: item.issue, projectInput: item.project })).id, iid: item.issue?.iid });
          } else if (resourceType === "group_issue") {
            results.push({ success: true, taskId: (await importItem(ctx, req, { resourceType, item: item.issue, groupInput: item.group })).id, iid: item.issue?.iid });
          } else if (resourceType === "merge_request") {
            results.push({ success: true, taskId: (await importItem(ctx, req, { resourceType, item: item.mergeRequest, projectInput: item.project })).id, iid: item.mergeRequest?.iid });
          } else {
            results.push({ success: false, error: "Unsupported resourceType" });
          }
        } catch (error) {
          results.push({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      res.json({ results });
    } catch (error) {
      rethrowAsApiError(error);
    }
  });
}
