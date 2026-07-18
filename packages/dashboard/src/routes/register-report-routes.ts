import { ApiError } from "../api-error.js";
import { queryKnowledgePagesAsync } from "../knowledge-index.js";
import { requireAsyncLayer } from "../require-async-layer.js";
import { runReportPipeline, type ReportInput, type StructuredReport } from "../report-pipeline.js";
import { createRoadmapDedupSourceForTaskStore } from "../report-roadmap-source.js";
import { scrubReportPayload } from "../report-scrub.js";
import { selfCheckHelp } from "../report-help-selfcheck.js";
import type { Request, Response } from "express";
import type { ApiRouteRegistrar } from "./types.js";

const ACTION_TYPES = new Set(["bug", "feedback", "idea", "help"]);
const MAX_ACTIVITY_TRACE_ENTRIES = 20;
const MAX_ACTIVITY_TRACE_CHARS = 4_000;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_ATTACHMENT_SOURCE = "report-attachment";

type ScopedStore = Awaited<ReturnType<Parameters<ApiRouteRegistrar>[0]["getScopedStore"]>>;

function isImagePayload(mimeType: string | undefined, bytes: Buffer): boolean {
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  return (mimeType === "image/png" && png) || (mimeType === "image/jpeg" && jpeg);
}

async function validateScreenshotArtifact(store: ScopedStore, input: ReportInput): Promise<ReportInput> {
  if (!input.screenshotArtifactId) return input;
  // FNXC:ReportPipeline 2026-07-16-10:30:
  // The client reference is untrusted. Validate UUID, scoped artifact type,
  // MIME, and report-upload provenance before it can become egressed text;
  // this blocks data-URI and arbitrary-text smuggling into GitHub reports.
  if (!ARTIFACT_ID_PATTERN.test(input.screenshotArtifactId)) throw new ApiError(400, "Invalid report screenshot reference.");
  const artifact = await store.getArtifact(input.screenshotArtifactId);
  if (artifact?.type !== "image" || !["image/png", "image/jpeg"].includes(artifact.mimeType ?? "") || artifact.metadata?.source !== REPORT_ATTACHMENT_SOURCE) {
    throw new ApiError(400, "Invalid report screenshot reference.");
  }
  return input;
}

function runUpload(upload: NonNullable<Parameters<ApiRouteRegistrar>[0]["reportUpload"]>, req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => upload.single("screenshot")(req, res, (error?: unknown) => error ? reject(error) : resolve()));
}

function parseActivityTrace(value: unknown): ReportInput["activityTrace"] {
  if (!Array.isArray(value)) return undefined;
  const entries = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.ts !== "string" || typeof candidate.kind !== "string" || typeof candidate.label !== "string") return [];
    return [{ ts: candidate.ts.slice(0, 64), kind: candidate.kind.slice(0, 80), label: candidate.label.slice(0, 1_000) }];
  });
  while (entries.length > MAX_ACTIVITY_TRACE_ENTRIES || entries.reduce((total, entry) => total + entry.ts.length + entry.kind.length + entry.label.length, 0) > MAX_ACTIVITY_TRACE_CHARS) entries.shift();
  return entries;
}

async function gatherReportContext(store: Awaited<ReturnType<Parameters<ApiRouteRegistrar>[0]["getScopedStore"]>>, input: ReportInput, settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = {
    reportMode: settings.reportMode,
    githubAuthMode: settings.githubAuthMode,
    taskId: input.contextRefs?.taskId,
    agentId: input.contextRefs?.agentId,
    activityTrace: input.activityTrace,
    ...(input.screenshotArtifactId ? { screenshot: `Screenshot captured and retained locally (artifact ${input.screenshotArtifactId}).` } : {}),
  };
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

function parseInput(body: unknown): ReportInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const actionType = typeof value.actionType === "string" ? value.actionType : "";
  const userPrompt = typeof value.userPrompt === "string" ? value.userPrompt : "";
  if (!ACTION_TYPES.has(actionType) || !userPrompt.trim()) throw new ApiError(400, "A report type and description are required.");
  return {
    actionType: actionType as ReportInput["actionType"],
    userPrompt,
    contextRefs: typeof value.contextRefs === "object" && value.contextRefs ? value.contextRefs as ReportInput["contextRefs"] : undefined,
    activityTrace: parseActivityTrace(value.activityTrace),
    screenshotArtifactId: typeof value.screenshotArtifactId === "string" ? value.screenshotArtifactId : undefined,
  };
}

/**
 * FNXC:ReportPipeline 2026-07-16-12:00:
 * All report routes inherit dashboard auth and resolve a scoped store. The file
 * route treats edited drafts as untrusted and re-scrubs server-side immediately
 * before the pipeline may call GitHub.
 */
export const registerReportRoutes: ApiRouteRegistrar = ({ router, getScopedStore, rethrowAsApiError, reportUpload }) => {
  router.post("/report/attachment", async (req, res) => {
    try {
      if (!reportUpload) throw new ApiError(500, "Report attachment upload is unavailable.");
      await runUpload(reportUpload, req, res);
      const file = req.file;
      if (!file || file.size > MAX_SCREENSHOT_BYTES || !isImagePayload(file.mimetype, file.buffer)) throw new ApiError(400, "Report screenshots must be PNG or JPEG files up to 2MB.");
      const store = await getScopedStore(req);
      const contextRefs = typeof req.body?.contextRefs === "string" ? JSON.parse(req.body.contextRefs) : req.body?.contextRefs;
      const taskId = contextRefs && typeof contextRefs.taskId === "string" ? contextRefs.taskId : undefined;
      const artifact = await store.registerArtifact({ type: "image", title: "Report screenshot", mimeType: file.mimetype, data: Buffer.from(file.buffer), taskId, authorType: "user", authorId: "dashboard-user", metadata: { source: REPORT_ATTACHMENT_SOURCE } });
      // FNXC:ReportPipeline 2026-07-16-10:30:
      // Pixels are unscrubbable. Persist this optional, confirmed screenshot
      // locally only; no GitHub transport receives its bytes or a data URI.
      res.status(201).json({ artifactId: artifact.id, uri: artifact.uri });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error, "Failed to retain report screenshot");
    }
  });

  router.post("/report/draft", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const scopes = await store.getSettingsByScopeFast();
      const input = await validateScreenshotArtifact(store, parseInput(req.body));
      const help = await selfCheckHelpBeforePipeline(store, input);
      if (help?.answered) {
        res.json({ kind: "help", answer: help.answer });
        return;
      }
      const result = await runReportPipeline(input, {
        projectSettings: scopes.project,
        globalSettings: scopes.global,
        scrubContext: { rootDir: store.getRootDir(), projectName: store.getRootDir().split(/[\\/]/).pop() },
        gatherContext: (reportInput) => gatherReportContext(store, reportInput, scopes.project as Record<string, unknown>),
        roadmapSource: scopes.project.reportRoadmapDedup ? createRoadmapDedupSourceForTaskStore(store) : undefined,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error, "Failed to prepare report draft");
    }
  });

  router.post("/report/file", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const scopes = await store.getSettingsByScopeFast();
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const untrusted = scrubReportPayload((raw.report ?? raw) as StructuredReport, { rootDir: store.getRootDir(), projectName: store.getRootDir().split(/[\\/]/).pop() });
      const input = parseInput({
        actionType: raw.actionType ?? (untrusted.context as Record<string, unknown> | undefined)?.actionType ?? "bug",
        userPrompt: untrusted.userPrompt ?? untrusted.summary,
        contextRefs: (untrusted.context as Record<string, unknown> | undefined) && {
          taskId: typeof (untrusted.context as Record<string, unknown>).taskId === "string" ? (untrusted.context as Record<string, unknown>).taskId : undefined,
          agentId: typeof (untrusted.context as Record<string, unknown>).agentId === "string" ? (untrusted.context as Record<string, unknown>).agentId : undefined,
        },
        activityTrace: raw.activityTrace ?? (untrusted.context as Record<string, unknown> | undefined)?.activityTrace,
        screenshotArtifactId: raw.screenshotArtifactId ?? (untrusted.context as Record<string, unknown> | undefined)?.screenshotArtifactId,
      });
      const validatedInput = await validateScreenshotArtifact(store, input);
      const endorseIssueNumber = typeof raw.endorseIssueNumber === "number" ? raw.endorseIssueNumber : undefined;
      const endorseDiscussionId = typeof raw.endorseDiscussionId === "string" ? raw.endorseDiscussionId : undefined;
      const help = await selfCheckHelpBeforePipeline(store, validatedInput);
      if (help?.answered) {
        res.json({ kind: "help", answer: help.answer });
        return;
      }
      const result = await runReportPipeline(validatedInput, {
        projectSettings: scopes.project,
        globalSettings: scopes.global,
        scrubContext: { rootDir: store.getRootDir(), projectName: store.getRootDir().split(/[\\/]/).pop() },
        gatherContext: (reportInput) => gatherReportContext(store, reportInput, scopes.project as Record<string, unknown>),
        roadmapSource: scopes.project.reportRoadmapDedup ? createRoadmapDedupSourceForTaskStore(store) : undefined,
      }, { file: true, endorseIssueNumber, endorseDiscussionId, report: untrusted });
      res.json(result);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error, "Failed to file report");
    }
  });

  router.post("/report/help", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const question = typeof req.body?.question === "string" ? req.body.question : "";
      const layer = requireAsyncLayer(store, "Help self-check");
      const result = await selfCheckHelp(question, (query) => queryKnowledgePagesAsync(layer, { query, limit: 1 }));
      res.json(result);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error, "Failed to self-check help question");
    }
  });
};
