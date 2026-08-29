import { REPORT_ATTACHMENT_SOURCE, resolveTaskGithubTracking } from "@fusion/core";
import { ALLOWED_IMAGE_MIMES, MAX_IMAGE_BYTES } from "../issue-image-attachments.js";
import { readArtifactMediaBytes } from "../artifact-media.js";
import type { Request, Response } from "express";
import { ApiError } from "../api-error.js";
import { GitHubClient } from "../github.js";
import { resolveGithubTrackingAuth } from "../github-auth.js";
import { queryKnowledgePagesAsync } from "../knowledge-index.js";
import { requireAsyncLayer } from "../require-async-layer.js";
import { runReportPipeline, type ReportInput, type ReportScreenshot, type StructuredReport } from "../report-pipeline.js";
import { scrubReportPayload } from "../report-scrub.js";
import { selfCheckHelp } from "../report-help-selfcheck.js";
import type { ApiRouteRegistrar } from "./types.js";

const ACTION_TYPES = new Set(["bug", "feedback", "idea", "help"]);
const REPORT_TARGETS = new Set(["issue", "discussion"]);
const MAX_ACTIVITY_TRACE_ENTRIES = 20;
const MAX_ACTIVITY_TRACE_CHARS = 4_000;
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
/** UUID v4 references keep report input independent of binary transport. */
export const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

function parseActivityTrace(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.slice(0, 1_000));
  if (entries.length !== value.length || entries.length > MAX_ACTIVITY_TRACE_ENTRIES || entries.join("").length > MAX_ACTIVITY_TRACE_CHARS) throw new ApiError(400, "Activity trace is invalid.");
  return entries;
}

function parseScreenshotArtifactId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ARTIFACT_ID_PATTERN.test(value)) throw new ApiError(400, "Screenshot artifact reference is invalid.");
  return value;
}

async function resolveReportScreenshot(store: Awaited<ReturnType<Parameters<ApiRouteRegistrar>[0]["getScopedStore"]>>, id: string | undefined): Promise<ReportScreenshot | undefined> {
  if (!id) return undefined;
  const artifact = await store.getArtifact(id);
  if (artifact?.type !== "image" || artifact.metadata?.source !== REPORT_ATTACHMENT_SOURCE || !artifact.mimeType || !ALLOWED_IMAGE_MIMES.has(artifact.mimeType)) throw new ApiError(400, "Screenshot artifact is unavailable or invalid.");
  const bytes = await readArtifactMediaBytes(store, artifact);
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || imageMimeType(bytes) !== artifact.mimeType) throw new ApiError(400, "Screenshot artifact is unavailable or invalid.");
  return { artifactId: artifact.id, filename: artifact.title || "Report screenshot", mimeType: artifact.mimeType, bytes };
}

function parseDiscussionCategoryId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new ApiError(400, "Discussion category must be a non-empty string.");
  return value;
}

async function validateScreenshotArtifact(store: Awaited<ReturnType<Parameters<ApiRouteRegistrar>[0]["getScopedStore"]>>, id: string | undefined): Promise<void> {
  if (!id) return;
  const artifact = await store.getArtifact(id);
  if (artifact?.type !== "image" || artifact.metadata?.source !== REPORT_ATTACHMENT_SOURCE || !artifact.mimeType || !ALLOWED_IMAGE_MIMES.has(artifact.mimeType)) throw new ApiError(400, "Screenshot artifact is unavailable or invalid.");
}

function imageMimeType(buffer: Buffer): "image/png" | "image/jpeg" | undefined {
  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "image/png";
  if (buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return "image/jpeg";
  return undefined;
}

async function gatherReportContext(store: Awaited<ReturnType<Parameters<ApiRouteRegistrar>[0]["getScopedStore"]>>, input: ReportInput, settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = { reportMode: settings.reportMode, githubAuthMode: settings.githubAuthMode, taskId: input.contextRefs?.taskId, agentId: input.contextRefs?.agentId, activityTrace: input.activityTrace };
  if (!input.contextRefs?.taskId) return context;
  const task = await store.getTask(input.contextRefs.taskId).catch(() => null);
  if (!task) return context;
  const logs = await store.getAgentLogs(task.id, { limit: 10 }).catch(() => []);
  context.task = { id: task.id, title: task.title, column: task.column, status: task.status, error: task.error, assignedAgentId: task.assignedAgentId };
  context.recentLogs = logs.map((entry) => entry.text ?? JSON.stringify(entry)).slice(-10);
  return context;
}

async function selfCheckHelpBeforePipeline(store: Awaited<ReturnType<Parameters<ApiRouteRegistrar>[0]["getScopedStore"]>>, input: ReportInput) {
  if (input.actionType !== "help") return undefined;
  const layer = requireAsyncLayer(store, "Help self-check");
  return selfCheckHelp(input.userPrompt, (query) => queryKnowledgePagesAsync(layer, { query, limit: 1 }));
}

function parseTargetType(value: unknown): "issue" | "discussion" | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !REPORT_TARGETS.has(value)) throw new ApiError(400, "Report target must be issue or discussion.");
  return value as "issue" | "discussion";
}

function parseInput(body: unknown): ReportInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const actionType = typeof value.actionType === "string" ? value.actionType : "";
  const userPrompt = typeof value.userPrompt === "string" ? value.userPrompt : "";
  if (!ACTION_TYPES.has(actionType) || !userPrompt.trim()) throw new ApiError(400, "A report type and description are required.");
  return { actionType: actionType as ReportInput["actionType"], userPrompt, contextRefs: typeof value.contextRefs === "object" && value.contextRefs ? value.contextRefs as ReportInput["contextRefs"] : undefined, activityTrace: parseActivityTrace(value.activityTrace), screenshotArtifactId: parseScreenshotArtifactId(value.screenshotArtifactId) };
}

/**
 * FNXC:ReportPipeline 2026-07-19-10:00:
 * Report routes persist opted-in PNG/JPEG pixels locally as provenance-marked
 * artifacts. Draft and file requests carry only a validated reference and text
 * note. Filing resolves that explicit reference through the guarded artifact-media
 * seam before the separately consented Contents-API upload; raw request pixels are never accepted.
 */
export const registerReportRoutes: ApiRouteRegistrar = ({ router, getScopedStore, rethrowAsApiError, reportUpload }) => {
  const attachment = async (req: Request & { file?: { buffer?: Buffer; mimetype?: string } }, res: Response) => {
    try {
      const store = await getScopedStore(req);
      const file = req.file;
      const mimeType = file?.buffer ? imageMimeType(file.buffer) : undefined;
      if (!file?.buffer || file.buffer.length === 0 || file.buffer.length > MAX_SCREENSHOT_BYTES || !mimeType) throw new ApiError(400, "A PNG or JPEG screenshot under 2MB is required.");
      const artifact = await store.registerArtifact({ type: "image", title: "Report screenshot", authorId: REPORT_ATTACHMENT_SOURCE, authorType: "system", metadata: { source: REPORT_ATTACHMENT_SOURCE }, data: file.buffer, mimeType });
      res.json({ artifactId: artifact.id });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error, "Failed to store report screenshot");
    }
  };
  if (reportUpload) router.post("/report/attachment", reportUpload.single("screenshot"), attachment);
  else router.post("/report/attachment", attachment);

  router.post("/report/draft", async (req, res) => {
    try {
      const store = await getScopedStore(req); const scopes = await store.getSettingsByScopeFast(); const input = parseInput(req.body);
      // FNXC:ReportPipeline 2026-07-16-21:00: Validate target before Help can return locally.
      const targetType = parseTargetType((req.body as Record<string, unknown> | undefined)?.targetType);
      const discussionCategoryId = parseDiscussionCategoryId((req.body as Record<string, unknown> | undefined)?.discussionCategoryId);
      await validateScreenshotArtifact(store, input.screenshotArtifactId);
      const help = await selfCheckHelpBeforePipeline(store, input);
      if (help?.answered) return void res.json({ kind: "help", answer: help.answer });
      res.json(await runReportPipeline(input, { projectSettings: scopes.project, globalSettings: scopes.global, scrubContext: { rootDir: store.getRootDir(), projectName: store.getRootDir().split(/[\\/]/).pop() }, gatherContext: (reportInput) => gatherReportContext(store, reportInput, scopes.project as Record<string, unknown>) }, { ...(targetType ? { targetType } : {}), ...(discussionCategoryId ? { discussionCategoryId } : {}) }));
    } catch (error) { if (error instanceof ApiError) throw error; rethrowAsApiError(error, "Failed to prepare report draft"); }
  });

  router.post("/report/file", async (req, res) => {
    try {
      const store = await getScopedStore(req); const scopes = await store.getSettingsByScopeFast(); const raw = (req.body ?? {}) as Record<string, unknown>; const rawReport = (raw.report ?? raw) as StructuredReport;
      const rootDir = store.getRootDir();
      const scrubContext = { rootDir, projectName: rootDir.split(/[\\/]/).pop() };
      const { screenshotArtifactId: reportArtifactId, attachment: _untrustedAttachment, ...textualRawReport } = rawReport;
      const untrusted = scrubReportPayload(textualRawReport, scrubContext);
      /*
       * FNXC:ReportPipeline 2026-07-20-12:00:
       * /report/file must scrub top-level activityTrace before parseInput and the
       * pipeline boundary. Raw traces previously bypassed the edited-report scrub
       * and exposed path, project, or token labels to gatherReportContext; the
       * nested context fallback remains covered by textualRawReport scrubbing.
       */
      const rawActivityTrace = raw.activityTrace === undefined ? undefined : scrubReportPayload({ activityTrace: raw.activityTrace }, scrubContext).activityTrace;
      const input = parseInput({ actionType: raw.actionType ?? (untrusted.context as Record<string, unknown> | undefined)?.actionType ?? "bug", userPrompt: untrusted.userPrompt ?? untrusted.summary, contextRefs: (untrusted.context as Record<string, unknown> | undefined) && { taskId: typeof (untrusted.context as Record<string, unknown>).taskId === "string" ? (untrusted.context as Record<string, unknown>).taskId : undefined, agentId: typeof (untrusted.context as Record<string, unknown>).agentId === "string" ? (untrusted.context as Record<string, unknown>).agentId : undefined }, activityTrace: rawActivityTrace ?? (untrusted.context as Record<string, unknown> | undefined)?.activityTrace, screenshotArtifactId: raw.screenshotArtifactId ?? reportArtifactId });
      // FNXC:ReportPipeline 2026-07-16-21:00: Validate target before Help can return locally.
      const targetType = parseTargetType(raw.targetType);
      const discussionCategoryId = parseDiscussionCategoryId(raw.discussionCategoryId);
      const attachment = await resolveReportScreenshot(store, input.screenshotArtifactId);
      const inputWithAttachment = attachment ? { ...input, attachment } : input;
      const help = await selfCheckHelpBeforePipeline(store, inputWithAttachment);
      if (help?.answered) return void res.json({ kind: "help", answer: help.answer });
      res.json(await runReportPipeline(inputWithAttachment, { projectSettings: scopes.project, globalSettings: scopes.global, scrubContext, gatherContext: (reportInput) => gatherReportContext(store, reportInput, scopes.project as Record<string, unknown>) }, { file: true, targetType, discussionCategoryId, endorseIssueNumber: typeof raw.endorseIssueNumber === "number" ? raw.endorseIssueNumber : undefined, endorseDiscussionId: typeof raw.endorseDiscussionId === "string" ? raw.endorseDiscussionId : undefined, endorseRoadmapIssueNumber: typeof raw.endorseRoadmapIssueNumber === "number" ? raw.endorseRoadmapIssueNumber : undefined, report: untrusted }));
    } catch (error) { if (error instanceof ApiError) throw error; rethrowAsApiError(error, "Failed to file report"); }
  });

  router.get("/report/discussion-categories", async (req, res) => {
    try {
      const store = await getScopedStore(req); const scopes = await store.getSettingsByScopeFast();
      const auth = resolveGithubTrackingAuth({ projectSettings: scopes.project, globalSettings: scopes.global });
      const repo = resolveTaskGithubTracking({ githubTracking: undefined }, scopes.project, scopes.global).repo;
      if (!auth.ok || !repo) return void res.json({ categories: [], reason: auth.ok ? "repo_missing" : auth.reason });
      const client = auth.auth.mode === "token" ? new GitHubClient({ token: auth.auth.token, forceMode: "token" }) : new GitHubClient({ forceMode: "gh-cli" });
      try { res.json({ categories: await client.listDiscussionCategories(repo.owner, repo.repo) }); } catch { res.json({ categories: [], reason: "discussion_categories_unavailable" }); }
    } catch (error) { if (error instanceof ApiError) throw error; rethrowAsApiError(error, "Failed to list Discussion categories"); }
  });

  router.post("/report/help", async (req, res) => { try { const store = await getScopedStore(req); const layer = requireAsyncLayer(store, "Help self-check"); res.json(await selfCheckHelp(typeof req.body?.question === "string" ? req.body.question : "", (query) => queryKnowledgePagesAsync(layer, { query, limit: 1 }))); } catch (error) { if (error instanceof ApiError) throw error; rethrowAsApiError(error, "Failed to self-check help question"); } });
};
