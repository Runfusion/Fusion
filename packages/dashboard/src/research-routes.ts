import { Router } from "express";
import { archivedColumnsForTask } from "./task-lifecycle-lanes.js";
import type { NextFunction, Request, Response } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskStore, ResearchRun, TaskCreateInput } from "@fusion/core";
import {
  RESEARCH_RUN_STATUSES,
  RESEARCH_SOURCE_TYPES,
  RESEARCH_SOURCE_STATUSES,
  RESEARCH_EVENT_TYPES,
  ResearchLifecycleError,
  buildResearchDocumentKey,
  resolveResearchFindingId,
  promoteResearchFinding,
  createRecallCaptureWriter,
  createLogger,
  NOOP_RECALL_CAPTURE_WRITER,
  type ResearchRunListOptions,
  type ResearchRunStatus,
} from "@fusion/core";
import { ApiError, badRequest, notFound } from "./api-error.js";
import { getScopedStore as resolveScopedRequestStore } from "./routes/context.js";
import type { ServerOptions } from "./server.js";

const DEFAULT_AVAILABILITY = {
  available: true,
  supportedProviders: ["web-search", "page-fetch", "github", "local-docs", "llm-synthesis"],
  supportedExportFormats: ["markdown", "json", "html"],
  setupInstructions: "If research fails to start, check Settings → Models and Authentication for provider enablement and credentials.",
} as const;

function rethrowAsApiError(error: unknown, fallback = "Internal server error"): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof ResearchLifecycleError) {
    const status = error.code === "invalid_transition" || error.code === "active_run_conflict" || error.code === "not_retryable"
      ? 409
      : 400;
    const mappedCode = error.code === "not_retryable"
      ? "NON_RETRYABLE_PROVIDER_ERROR"
      : "INVALID_TRANSITION";
    throw new ApiError(status, "The requested research lifecycle action is not allowed.", { code: mappedCode, retryable: false });
  }
  if (error instanceof Error) throw new ApiError(500, fallback, { code: "INTERNAL_ERROR" });
  throw new ApiError(500, fallback, { code: "INTERNAL_ERROR" });
}

type ResearchApiDiagnosis = {
  classification: string;
  code: string;
  retryable: boolean;
  detail: string;
  remediation?: string;
};

const RESEARCH_TERMINAL_STATUSES = new Set(["failed", "cancelled", "timed_out", "retry_exhausted"]);
const MAX_DIAGNOSTIC_TEXT_LENGTH = 500;

function safeDiagnosticText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // FNXC:ResearchFailureDiagnostics 2026-09-28-21:05:
  // API readers expose only bounded operator guidance. Defense-in-depth redaction prevents legacy lifecycle
  // prose from carrying credentials, authorization headers, URLs with query values, or local paths to clients.
  return trimmed
    .replace(/\b(?:sk|pk|api|key|token)-[A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/\b(authorization|api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(?:[A-Za-z]:\\|\/(?:home|Users|var|tmp)\/)\S+/g, "[redacted-path]")
    .slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);
}

function fallbackDiagnosis(run: ResearchRun): ResearchApiDiagnosis {
  switch (run.status) {
    case "cancelled":
      return { classification: "cancelled", code: "RUN_CANCELLED", retryable: false, detail: "Research run was cancelled." };
    case "timed_out":
      return {
        classification: "timed_out",
        code: "PROVIDER_TIMEOUT",
        retryable: true,
        detail: "Research providers did not finish before the run deadline.",
        remediation: "Retry the run. If timeouts continue, review Research Settings and provider availability.",
      };
    case "retry_exhausted":
      return {
        classification: "non_retryable",
        code: "RETRY_EXHAUSTED",
        retryable: false,
        detail: "Research run exhausted its retry attempts.",
        remediation: "Review provider configuration before starting a new run.",
      };
    default:
      return {
        classification: "non_retryable",
        code: "INTERNAL_ERROR",
        retryable: false,
        detail: "Research run failed without additional diagnostic detail.",
        remediation: "Review Research Settings and provider authentication, then start a new run.",
      };
  }
}

function toRunDiagnosis(run: ResearchRun): ResearchApiDiagnosis | undefined {
  if (!RESEARCH_TERMINAL_STATUSES.has(run.status)) return undefined;

  const lifecycle = run.lifecycle as (ResearchRun["lifecycle"] & { remediation?: string; safeDetail?: string; detail?: string }) | undefined;
  const fallback = fallbackDiagnosis(run);
  return {
    classification: lifecycle?.failureClass ?? fallback.classification,
    code: lifecycle?.errorCode ?? fallback.code,
    retryable: lifecycle?.retryable ?? fallback.retryable,
    detail: safeDiagnosticText(lifecycle?.safeDetail ?? lifecycle?.detail ?? lifecycle?.terminalCause) ?? fallback.detail,
    remediation: safeDiagnosticText(lifecycle?.remediation) ?? fallback.remediation,
  };
}

function toRunListItem(run: ResearchRun) {
  return {
    id: run.id,
    query: run.query,
    title: run.topic || run.query,
    status: run.status,
    summary: run.results?.summary,
    diagnosis: toRunDiagnosis(run),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function toRunDetail(run: ResearchRun) {
  const diagnosis = toRunDiagnosis(run);
  const lifecycle = run.lifecycle
    ? {
        ...run.lifecycle,
        terminalCause: diagnosis?.detail,
        ...("remediation" in run.lifecycle ? { remediation: diagnosis?.remediation } : {}),
        ...("safeDetail" in run.lifecycle ? { safeDetail: diagnosis?.detail } : {}),
        ...("detail" in run.lifecycle ? { detail: diagnosis?.detail } : {}),
      }
    : undefined;
  return {
    ...run,
    // Raw legacy errors and event metadata may contain provider payloads. The bounded diagnosis is the only failure prose returned.
    error: diagnosis?.detail,
    lifecycle,
    events: run.events.map((event) => ({
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      message: event.type === "error" ? "Research step failed. See the run diagnosis for details." : (safeDiagnosticText(event.message) ?? "Research event"),
    })),
    diagnosis,
    title: run.topic || run.query,
  };
}

function getFindingId(finding: NonNullable<ResearchRun["results"]>["findings"][number]): string {
  return resolveResearchFindingId(finding);
}

function getFindingById(run: ResearchRun, findingId: string) {
  const findings = run.results?.findings ?? [];
  for (const finding of findings) {
    if (getFindingId(finding) === findingId) {
      return { finding, findingId };
    }
  }
  return null;
}

function buildFindingTaskSummary(run: ResearchRun, finding: NonNullable<ResearchRun["results"]>["findings"][number]): string {
  const heading = finding.heading?.trim() || "Research finding";
  const content = finding.content?.trim() || "";
  const firstSentence = content.split(/(?<=[.!?])\s+/)[0]?.trim() || content;
  const scope = run.topic || run.query;
  return `${heading} — ${firstSentence || "Review cited research details."}\n\nContext: ${scope}`;
}

function buildFindingMarkdown(run: ResearchRun, findingId: string, finding: NonNullable<ResearchRun["results"]>["findings"][number]): string {
  const citations = (finding.sources ?? []).map((source) => `- ${source}`).join("\n");
  const runSummary = run.results?.summary?.trim();
  return [
    `# Research Finding`,
    ``,
    `- Run ID: ${run.id}`,
    `- Finding ID: ${findingId}`,
    `- Query: ${run.query}`,
    ``,
    `## ${finding.heading || "Finding"}`,
    finding.content || "",
    runSummary ? `\n## Run Summary\n${runSummary}` : "",
    citations ? `\n## Citations\n${citations}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function validateAttachExport(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw badRequest("attachExport must be a boolean");
  }
  return value;
}

function isAttachmentValidationError(error: unknown): error is Error {
  return error instanceof Error
    && (error.message.startsWith("Invalid mime type") || error.message.startsWith("File too large"));
}

async function addFindingAttachment(
  scopedStore: TaskStore,
  taskId: string,
  filename: string,
  markdown: string,
): Promise<string> {
  try {
    const attachment = await scopedStore.addAttachment(taskId, filename, Buffer.from(markdown, "utf8"), "text/markdown");
    return attachment.filename;
  } catch (error) {
    if (isAttachmentValidationError(error)) {
      throw badRequest(error.message);
    }
    throw error;
  }
}

export function createResearchRouter(store: TaskStore, options?: ServerOptions): Router {
  const router = Router();
  const requestContext = new AsyncLocalStorage<TaskStore>();

  router.use((req: Request, _res: Response, next: NextFunction) => {
    // FNXC:CentralProjectIdentity 2026-07-13-23:54:
    // Resolve an explicit central-registry project id via the shared seam
    // (request id → registered launch project id → raw launch store last resort).
    // FNXC:CentralProjectIdentity 2026-07-14-00:15:
    // Catch-and-FORWARD via next(): rethrowAsApiError throws, and a throw inside this
    // detached promise chain escapes Express (not the request's synchronous call
    // stack), so a store-resolution failure would hang the request. Mirror the
    // insights/goals routers' pattern.
    resolveScopedRequestStore(req, store, options)
      .then((scopedStore) => requestContext.run(scopedStore, () => next()))
      .catch((error) => {
        try {
          rethrowAsApiError(error, "Failed to resolve project store");
        } catch (apiError) {
          next(apiError);
        }
      });
  });

  // FNXC:ResearchStore 2026-06-27-12:20:
  // Returns the active ResearchStore (sync SQLite) or AsyncResearchStore (PG backend).
  // Both expose the same method names; handlers `await` every call so either backend
  // works — the interim PG 503 guard is removed now that the store is ported.
  const getStore = () => {
    const scoped = requestContext.getStore();
    if (!scoped) throw new ApiError(500, "Store context not available");
    return scoped.getResearchStore();
  };

  router.get("/runs", async (req, res) => {
    try {
      const options: ResearchRunListOptions = {};
      if (typeof req.query.status === "string") {
        if (!RESEARCH_RUN_STATUSES.includes(req.query.status as ResearchRunStatus)) {
          throw badRequest(`Invalid status: ${req.query.status}`);
        }
        options.status = req.query.status as ResearchRunStatus;
      }
      if (typeof req.query.q === "string") options.search = req.query.q;
      if (typeof req.query.limit === "string") options.limit = Number.parseInt(req.query.limit, 10);

      const runs = await getStore().listRuns(options);
      res.json({ runs: runs.map(toRunListItem), availability: DEFAULT_AVAILABILITY });
    } catch (error) {
      rethrowAsApiError(error, "Failed to list research runs");
    }
  });

  router.post("/runs", async (req, res) => {
    try {
      if (typeof req.body?.query !== "string" || !req.body.query.trim()) {
        throw badRequest("query is required");
      }

      const run = await getStore().createRun({
        query: req.body.query,
        topic: req.body.query,
        providerConfig: {
          providers: req.body.providers,
          githubRepo: req.body.githubRepo,
          githubIssueNumber: req.body.githubIssueNumber,
          includeLocalDocs: req.body.includeLocalDocs,
          enableSynthesis: req.body.enableSynthesis,
          maxResults: req.body.maxResults,
          depth: req.body.depth,
        },
      });
      res.status(201).json({ run: toRunDetail(run), availability: DEFAULT_AVAILABILITY });
    } catch (error) {
      rethrowAsApiError(error, "Failed to create research run");
    }
  });

  router.get("/runs/:id", async (req, res) => {
    try {
      const run = await getStore().getRun(req.params.id);
      if (!run) throw notFound(`Run not found: ${req.params.id}`);
      res.json({ run: toRunDetail(run), availability: DEFAULT_AVAILABILITY });
    } catch (error) {
      rethrowAsApiError(error, "Failed to get research run");
    }
  });

  router.post("/runs/:id/cancel", async (req, res) => {
    try {
      const existing = await getStore().getRun(req.params.id);
      if (!existing) throw notFound(`Run not found: ${req.params.id}`);
      if (["completed", "failed", "cancelled", "timed_out", "retry_exhausted"].includes(existing.status)) {
        const diagnosis = toRunDiagnosis(existing);
        res.status(409).json({
          error: `Run ${req.params.id} cannot be cancelled from status ${existing.status}`,
          code: "INVALID_TRANSITION",
          details: {
            code: "INVALID_TRANSITION",
            retryable: false,
            setupHint: diagnosis?.remediation,
            diagnosis,
          },
        });
        return;
      }
      const run = await getStore().requestCancellation(req.params.id);
      res.json({ run: toRunDetail(run) });
    } catch (error) {
      rethrowAsApiError(error, "Failed to cancel research run");
    }
  });

  router.post("/runs/:id/retry", async (req, res) => {
    try {
      const existing = await getStore().getRun(req.params.id);
      if (!existing) throw notFound(`Run not found: ${req.params.id}`);
      const retryRun = await getStore().createRetryRun(req.params.id);
      res.json({ run: toRunDetail(retryRun) });
    } catch (error) {
      if (error instanceof ResearchLifecycleError && error.code === "not_retryable") {
        const run = await getStore().getRun(req.params.id);
        const exhausted = run?.status === "retry_exhausted" || run?.lifecycle?.errorCode === "RETRY_EXHAUSTED";
        const code = exhausted ? "RETRY_EXHAUSTED" : "NON_RETRYABLE_PROVIDER_ERROR";
        const diagnosis = run ? toRunDiagnosis(run) : undefined;
        res.status(409).json({
          error: diagnosis?.detail ?? "This research outcome is not retryable.",
          code,
          details: {
            code,
            retryable: false,
            setupHint: diagnosis?.remediation,
            diagnosis,
          },
        });
        return;
      }
      if (error instanceof ResearchLifecycleError && error.code === "invalid_transition") {
        res.status(409).json({
          error: "The research run cannot be retried from its current status.",
          code: "INVALID_TRANSITION",
          details: { code: "INVALID_TRANSITION", retryable: false },
        });
        return;
      }
      rethrowAsApiError(error, "Failed to retry research run");
    }
  });

  router.get("/runs/:id/export", async (req, res) => {
    try {
      const run = await getStore().getRun(req.params.id);
      if (!run) throw notFound(`Run not found: ${req.params.id}`);

      const format = String(req.query.format ?? "markdown");
      if (format === "json") {
        res.json({ format, filename: `${run.id}.json`, content: JSON.stringify(toRunDetail(run), null, 2) });
        return;
      }
      if (format === "html") {
        const html = `<h1>${run.topic || run.query}</h1><p>${run.results?.summary ?? ""}</p>`;
        res.json({ format, filename: `${run.id}.html`, content: html });
        return;
      }
      if (format !== "markdown") throw badRequest(`Unsupported format: ${format}`);

      const markdown = `# ${run.topic || run.query}\n\n${run.results?.summary ?? ""}`;
      res.json({ format: "markdown", filename: `${run.id}.md`, content: markdown });
    } catch (error) {
      rethrowAsApiError(error, "Failed to export research run");
    }
  });

  router.post("/runs/:runId/findings/:findingId/task", async (req, res) => {
    try {
      const scopedStore = requestContext.getStore();
      if (!scopedStore) throw new ApiError(500, "Task store context unavailable");

      const run = await getStore().getRun(req.params.runId);
      if (!run) throw notFound(`Run not found: ${req.params.runId}`);
      const found = getFindingById(run, req.params.findingId);
      if (!found) throw notFound(`Finding not found: ${req.params.findingId}`);

      let documentKey: string;
      try {
        documentKey = buildResearchDocumentKey(req.params.runId);
      } catch {
        throw badRequest("Invalid run id for research document key");
      }

      const title = typeof req.body?.title === "string" && req.body.title.trim()
        ? req.body.title.trim()
        : `Research: ${found.finding.heading || run.topic || run.query}`;
      const description = typeof req.body?.description === "string" && req.body.description.trim()
        ? req.body.description.trim()
        : buildFindingTaskSummary(run, found.finding);
      const priority = req.body?.priority;
      if (priority !== undefined && !["low", "normal", "high", "urgent"].includes(priority)) {
        throw badRequest("priority must be one of: low, normal, high, urgent");
      }
      const attachExport = validateAttachExport(req.body?.attachExport);

      const taskInput: TaskCreateInput = {
        title,
        description,
        priority,
        source: {
          sourceType: "research",
          sourceRunId: run.id,
          sourceMetadata: {
            runId: run.id,
            findingId: found.findingId,
            findingLabel: found.finding.heading,
            documentKey,
          },
        },
      };

      const task = await scopedStore.createTask(taskInput);
      const markdown = buildFindingMarkdown(run, found.findingId, found.finding);
      await scopedStore.upsertTaskDocument(task.id, {
        key: documentKey,
        content: markdown,
        author: "research",
        metadata: {
          runId: run.id,
          findingId: found.findingId,
          findingLabel: found.finding.heading,
        },
      });
      if (typeof scopedStore.appendAgentLog === "function") {
        await scopedStore.appendAgentLog(
          task.id,
          `Task created from research finding ${found.findingId} in run ${run.id}`,
          "text",
          "research-task-integration",
          "executor",
        );
      }

      let attachmentFilename: string | undefined;
      if (attachExport) {
        const filename = `${run.id}-${found.findingId}.md`;
        const existing = await scopedStore.getTask(task.id);
        if (!existing.attachments?.some((attachment) => attachment.originalName === filename)) {
          attachmentFilename = await addFindingAttachment(scopedStore, task.id, filename, markdown);
        }
      }

      const responseTask = await scopedStore.getTask(task.id);
      res.status(201).json({ task: responseTask, documentKey, attachmentFilename });
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "Failed to create task from research finding";
      res.status(500).json({ error: message });
    }
  });

  router.post("/runs/:runId/findings/:findingId/promote", async (req, res) => {
    try {
      const scopedStore = requestContext.getStore();
      if (!scopedStore) throw new ApiError(500, "Task store context not available");
      const sliceId = typeof req.body?.sliceId === "string" ? req.body.sliceId.trim() : "";
      if (!sliceId) throw badRequest("sliceId is required");
      const missionStore = scopedStore.getMissionStore();
      if (!("addResearchFeature" in missionStore)) throw new ApiError(409, "Research promotion requires the PostgreSQL mission store");
      const layer = scopedStore.getAsyncLayer();
      const promoted = await promoteResearchFinding(
        getStore() as never,
        missionStore,
        {
          runId: req.params.runId,
          findingId: req.params.findingId,
          sliceId,
          title: typeof req.body?.title === "string" ? req.body.title : undefined,
          description: typeof req.body?.description === "string" ? req.body.description : undefined,
          acceptanceCriteria: typeof req.body?.acceptanceCriteria === "string" ? req.body.acceptanceCriteria : undefined,
        },
        layer
          ? createRecallCaptureWriter({ layer, logger: createLogger("research-recall-capture") })
          : NOOP_RECALL_CAPTURE_WRITER,
      );
      let feature = promoted.feature;
      if (typeof req.body?.taskId === "string" && req.body.taskId.trim()) feature = await missionStore.linkFeatureToTask(feature.id, req.body.taskId.trim());
      if (req.body?.triage === true) feature = await missionStore.triageFeature(feature.id);
      res.status(promoted.reused ? 200 : 201).json({ runId: promoted.runId, findingId: promoted.findingId, feature, sliceId, citations: promoted.citations, reused: promoted.reused, taskId: feature.taskId ?? null, status: feature.status });
    } catch (error) {
      rethrowAsApiError(error, "Failed to promote research finding");
    }
  });

  router.post("/runs/:runId/findings/:findingId/tasks/:taskId/enrich", async (req, res) => {
    try {
      const scopedStore = requestContext.getStore();
      if (!scopedStore) throw new ApiError(500, "Task store context unavailable");

      const run = await getStore().getRun(req.params.runId);
      if (!run) throw notFound(`Run not found: ${req.params.runId}`);
      const found = getFindingById(run, req.params.findingId);
      if (!found) throw notFound(`Finding not found: ${req.params.findingId}`);

      const task = await scopedStore.getTask(req.params.taskId);
      if (!task) throw notFound(`Task not found: ${req.params.taskId}`);
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-06:50 (batch-core):
      Archived tasks are read-only for research enrichment. Keyed on the literal, a renamed board let
      an ARCHIVED card be enriched — writes landing on a row the archive treats as immutable.
      */
      if ((await archivedColumnsForTask(scopedStore, task.id)).has(task.column)) throw new ApiError(409, "Cannot enrich archived task");

      let documentKey: string;
      try {
        documentKey = buildResearchDocumentKey(req.params.runId);
      } catch {
        throw badRequest("Invalid run id for research document key");
      }

      const markdown = buildFindingMarkdown(run, found.findingId, found.finding);
      const document = await scopedStore.upsertTaskDocument(task.id, {
        key: documentKey,
        content: markdown,
        author: "research",
        metadata: {
          runId: run.id,
          findingId: found.findingId,
          findingLabel: found.finding.heading,
        },
      });

      const attachExport = validateAttachExport(req.body?.attachExport);
      let attachmentFilename: string | undefined;
      if (attachExport) {
        const filename = `${run.id}-${found.findingId}.md`;
        if (!task.attachments?.some((attachment) => attachment.originalName === filename)) {
          attachmentFilename = await addFindingAttachment(scopedStore, task.id, filename, markdown);
        }
      }

      if (typeof scopedStore.appendAgentLog === "function") {
        await scopedStore.appendAgentLog(
          task.id,
          `Task enriched from research finding ${found.findingId} in run ${run.id}`,
          "text",
          "research-task-integration",
          "executor",
        );
      }
      res.json({ taskId: task.id, documentKey, revision: document.revision, attachmentFilename });
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "Failed to enrich task from research finding";
      res.status(500).json({ error: message });
    }
  });

  router.post("/runs/:id/events", async (req, res) => {
    try {
      const { type, message, metadata } = req.body ?? {};
      if (!RESEARCH_EVENT_TYPES.includes(type)) throw badRequest(`Invalid event type: ${String(type)}`);
      if (typeof message !== "string" || !message.trim()) throw badRequest("message is required");
      const event = await getStore().appendEvent(req.params.id, { type, message, metadata });
      res.status(201).json(event);
    } catch (error) {
      rethrowAsApiError(error, "Failed to append research event");
    }
  });

  router.patch("/runs/:id", async (req, res) => {
    try {
      const updated = await getStore().updateRun(req.params.id, req.body ?? {});
      if (!updated) throw notFound(`Run not found: ${req.params.id}`);
      res.json(updated);
    } catch (error) {
      rethrowAsApiError(error, "Failed to update research run");
    }
  });

  router.delete("/runs/:id", async (req, res) => {
    try {
      const deleted = await getStore().deleteRun(req.params.id);
      if (!deleted) throw notFound(`Run not found: ${req.params.id}`);
      res.status(204).send();
    } catch (error) {
      rethrowAsApiError(error, "Failed to delete research run");
    }
  });

  router.post("/runs/:id/sources", async (req, res) => {
    try {
      const { type, status } = req.body ?? {};
      if (!RESEARCH_SOURCE_TYPES.includes(type)) throw badRequest(`Invalid source type: ${String(type)}`);
      if (!RESEARCH_SOURCE_STATUSES.includes(status)) throw badRequest(`Invalid source status: ${String(status)}`);
      const source = await getStore().addSource(req.params.id, req.body);
      res.status(201).json(source);
    } catch (error) {
      rethrowAsApiError(error, "Failed to add research source");
    }
  });

  router.patch("/runs/:id/sources/:sourceId", async (req, res) => {
    try {
      await getStore().updateSource(req.params.id, req.params.sourceId, req.body ?? {});
      res.status(204).send();
    } catch (error) {
      rethrowAsApiError(error, "Failed to update research source");
    }
  });

  router.put("/runs/:id/results", async (req, res) => {
    try {
      await getStore().setResults(req.params.id, req.body);
      res.status(204).send();
    } catch (error) {
      rethrowAsApiError(error, "Failed to set research results");
    }
  });

  router.patch("/runs/:id/status", async (req, res) => {
    try {
      const status = req.body?.status as ResearchRunStatus | undefined;
      if (!status || !RESEARCH_RUN_STATUSES.includes(status)) throw badRequest(`Invalid status: ${String(status)}`);
      await getStore().updateStatus(req.params.id, status, req.body?.extra);
      const run = await getStore().getRun(req.params.id);
      if (!run) throw notFound(`Run not found: ${req.params.id}`);
      res.json(run);
    } catch (error) {
      rethrowAsApiError(error, "Failed to update research status");
    }
  });

  router.post("/runs/:id/exports", async (req, res) => {
    try {
      const format = req.body?.format;
      const content = req.body?.content;
      if (typeof content !== "string") throw badRequest("content is required");
      const exportRow = await getStore().createExport(req.params.id, format, content);
      res.status(201).json(exportRow);
    } catch (error) {
      rethrowAsApiError(error, "Failed to create research export");
    }
  });

  router.get("/runs/:id/exports", async (req, res) => {
    try {
      res.json({ exports: await getStore().getExports(req.params.id) });
    } catch (error) {
      rethrowAsApiError(error, "Failed to list research exports");
    }
  });

  router.get("/exports/:exportId", async (req, res) => {
    try {
      const exportRow = await getStore().getExport(req.params.exportId);
      if (!exportRow) throw notFound(`Export not found: ${req.params.exportId}`);
      res.json(exportRow);
    } catch (error) {
      rethrowAsApiError(error, "Failed to get research export");
    }
  });

  router.get("/stats", async (_req, res) => {
    try {
      res.json(await getStore().getStats());
    } catch (error) {
      rethrowAsApiError(error, "Failed to get research stats");
    }
  });

  router.get("/search", async (req, res) => {
    try {
      const q = String(req.query.q ?? "").trim();
      if (!q) throw badRequest("q is required");
      res.json({ runs: await getStore().searchRuns(q) });
    } catch (error) {
      rethrowAsApiError(error, "Failed to search research runs");
    }
  });

  return router;
}
