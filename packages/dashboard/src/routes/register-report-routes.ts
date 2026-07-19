import { ApiError } from "../api-error.js";
import { queryKnowledgePagesAsync } from "../knowledge-index.js";
import { requireAsyncLayer } from "../require-async-layer.js";
import { runReportPipeline, type ReportInput, type StructuredReport } from "../report-pipeline.js";
import { createRoadmapDedupSourceForTaskStore } from "../report-roadmap-source.js";
import { scrubReportPayload } from "../report-scrub.js";
import { selfCheckHelp } from "../report-help-selfcheck.js";
import type { ApiRouteRegistrar } from "./types.js";

const ACTION_TYPES = new Set(["bug", "feedback", "idea", "help"]);
const MAX_ACTIVITY_TRACE_ENTRIES = 20;
const MAX_ACTIVITY_TRACE_CHARS = 4_000;
const MAX_SCREENSHOT_DATA_URL_LENGTH = 2_800_000;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const SCREENSHOT_DATA_URL = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/i;

function parseActivityTrace(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.slice(0, 1_000));
  if (entries.length !== value.length || entries.length > MAX_ACTIVITY_TRACE_ENTRIES || entries.join("").length > MAX_ACTIVITY_TRACE_CHARS) throw new ApiError(400, "Activity trace is invalid.");
  return entries;
}

function parseScreenshot(value: unknown): ReportInput["screenshot"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new ApiError(400, "Screenshot is invalid.");
  const candidate = value as Record<string, unknown>;
  const match = typeof candidate.dataUrl === "string" && candidate.dataUrl.length <= MAX_SCREENSHOT_DATA_URL_LENGTH
    ? candidate.dataUrl.match(SCREENSHOT_DATA_URL)
    : undefined;
  if (typeof candidate.capturedAt !== "string" || !match || match[2].length % 4 !== 0) throw new ApiError(400, "Screenshot is invalid.");
  const bytes = Buffer.from(match[2], "base64");
  const canonical = bytes.toString("base64") === match[2];
  const isPng = match[1].toLowerCase() === "png" && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = match[1].toLowerCase() === "jpeg" && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  /*
  FNXC:ReportPipeline 2026-07-18-14:30:
  A data-URL prefix is not proof of an image. Decode the bounded payload and
  verify its declared PNG/JPEG signature before the reviewed screenshot reaches
  any configured host.
  */
  if (!canonical || bytes.length === 0 || bytes.length > MAX_SCREENSHOT_BYTES || (!isPng && !isJpeg)) throw new ApiError(400, "Screenshot is invalid.");
  return { dataUrl: match[0], capturedAt: candidate.capturedAt.slice(0, 64) };
}

async function gatherReportContext(store: Awaited<ReturnType<Parameters<ApiRouteRegistrar>[0]["getScopedStore"]>>, input: ReportInput, settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = {
    reportMode: settings.reportMode,
    githubAuthMode: settings.githubAuthMode,
    taskId: input.contextRefs?.taskId,
    agentId: input.contextRefs?.agentId,
    activityTrace: input.activityTrace,
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
    screenshot: parseScreenshot(value.screenshot),
  };
}

/**
 * FNXC:ReportPipeline 2026-07-16-12:00:
 * All report routes inherit dashboard auth and resolve a scoped store. The file
 * route treats edited drafts as untrusted and re-scrubs server-side immediately
 * before the pipeline may call GitHub.
 */
export const registerReportRoutes: ApiRouteRegistrar = ({ router, getScopedStore, rethrowAsApiError }) => {
  router.post("/report/draft", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const scopes = await store.getSettingsByScopeFast();
      const input = parseInput(req.body);
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
      const rawReport = (raw.report ?? raw) as StructuredReport;
      // Validate the only binary-bearing field before separating it from the
      // untrusted editable draft. scrubReportPayload intentionally scrubs every
      // string, including arbitrary pasted data URLs in report.body.
      const screenshot = parseScreenshot(raw.screenshot ?? rawReport.screenshot);
      const { screenshot: _submittedScreenshot, ...textualRawReport } = rawReport;
      const untrusted = scrubReportPayload(textualRawReport, { rootDir: store.getRootDir(), projectName: store.getRootDir().split(/[\\/]/).pop() });
      const input = parseInput({
        actionType: raw.actionType ?? (untrusted.context as Record<string, unknown> | undefined)?.actionType ?? "bug",
        userPrompt: untrusted.userPrompt ?? untrusted.summary,
        contextRefs: (untrusted.context as Record<string, unknown> | undefined) && {
          taskId: typeof (untrusted.context as Record<string, unknown>).taskId === "string" ? (untrusted.context as Record<string, unknown>).taskId : undefined,
          agentId: typeof (untrusted.context as Record<string, unknown>).agentId === "string" ? (untrusted.context as Record<string, unknown>).agentId : undefined,
        },
        activityTrace: raw.activityTrace ?? (untrusted.context as Record<string, unknown> | undefined)?.activityTrace,
        screenshot,
      });
      const validatedInput = input;
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
