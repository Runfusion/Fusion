import { Router } from "express";
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
  type ResearchRunListOptions,
  type ResearchRunStatus,
} from "@fusion/core";
import { ApiError, badRequest, notFound } from "./api-error.js";

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
    throw new ApiError(status, error.message, { code: mappedCode, retryable: false });
  }
  if (error instanceof Error) throw new ApiError(500, error.message, { code: "INTERNAL_ERROR" });
  throw new ApiError(500, fallback, { code: "INTERNAL_ERROR" });
}

function getProjectId(req: Request): string | undefined {
  if (typeof req.query.projectId === "string" && req.query.projectId.trim()) return req.query.projectId;
  if (req.body && typeof req.body === "object" && typeof req.body.projectId === "string" && req.body.projectId.trim()) return req.body.projectId;
  return undefined;
}

function toRunListItem(run: ResearchRun) {
  return {
    id: run.id,
    query: run.query,
    title: run.topic || run.query,
    status: run.status,
    summary: run.results?.summary,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function toRunDetail(run: ResearchRun) {
  return {
    ...run,
    title: run.topic || run.query,
  };
}

function getFindingId(finding: NonNullable<ResearchRun["results"]>["findings"][number], index: number): string {
  const maybeFinding = finding as { id?: unknown };
  const explicitId = typeof maybeFinding.id === "string" ? maybeFinding.id.trim() : "";
  return explicitId || `finding-${index + 1}`;
}

function getFindingById(run: ResearchRun, findingId: string) {
  const findings = run.results?.findings ?? [];
  for (const [index, finding] of findings.entries()) {
    if (getFindingId(finding, index) === findingId) {
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

export function createResearchRouter(store: TaskStore): Router {
  const router = Router();
  const requestContext = new AsyncLocalStorage<TaskStore>();

  router.use((req: Request, _res: Response, next: NextFunction) => {
    const projectId = getProjectId(req);
    if (!projectId) {
      requestContext.run(store, () => next());
      return;
    }

    import("./project-store-resolver.js")
      .then(({ getOrCreateProjectStore }) => getOrCreateProjectStore(projectId))
      .then((scopedStore) => requestContext.run(scopedStore, () => next()))
      .catch((error) => rethrowAsApiError(error, "Failed to resolve project store"));
  });

  const getStore = () => {
    const scoped = requestContext.getStore();
    if (!scoped) throw new ApiError(500, "Store context not available");
    return scoped.getResearchStore();
  };

  router.get("/runs", (req, res) => {
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

      const runs = getStore().listRuns(options);
      res.json({ runs: runs.map(toRunListItem), availability: DEFAULT_AVAILABILITY });
    } catch (error) {
      rethrowAsApiError(error, "Failed to list research runs");
    }
  });

  router.post("/runs", (req, res) => {
    try {
      if (typeof req.body?.query !== "string" || !req.body.query.trim()) {
        throw badRequest("query is required");
      }

      const run = getStore().createRun({
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

  router.get("/runs/:id", (req, res) => {
    try {
      const run = getStore().getRun(req.params.id);
      if (!run) throw notFound(`Run not found: ${req.params.id}`);
      res.json({ run: toRunDetail(run), availability: DEFAULT_AVAILABILITY });
    } catch (error) {
      rethrowAsApiError(error, "Failed to get research run");
    }
  });

  router.post("/runs/:id/cancel", (req, res) => {
    try {
      const existing = getStore().getRun(req.params.id);
      if (!existing) throw notFound(`Run not found: ${req.params.id}`);
      if (["completed", "failed", "cancelled", "timed_out", "retry_exhausted"].includes(existing.status)) {
        res.status(409).json({
          error: `Run ${req.params.id} cannot be cancelled from status ${existing.status}`,
          details: { code: "INVALID_TRANSITION", retryable: false },
        });
        return;
      }
      const run = getStore().requestCancellation(req.params.id);
      res.json({ run: toRunDetail(run) });
    } catch (error) {
      rethrowAsApiError(error, "Failed to cancel research run");
    }
  });

  router.post("/runs/:id/retry", (req, res) => {
    try {
      const existing = getStore().getRun(req.params.id);
      if (!existing) throw notFound(`Run not found: ${req.params.id}`);
      const retryRun = getStore().createRetryRun(req.params.id);
      res.json({ run: toRunDetail(retryRun) });
    } catch (error) {
      if (error instanceof ResearchLifecycleError && error.code === "not_retryable") {
        const run = getStore().getRun(req.params.id);
        const exhausted = run?.status === "retry_exhausted" || run?.lifecycle?.errorCode === "RETRY_EXHAUSTED";
        res.status(409).json({
          error: error.message,
          details: {
            code: exhausted ? "RETRY_EXHAUSTED" : "NON_RETRYABLE_PROVIDER_ERROR",
            retryable: false,
          },
        });
        return;
      }
      if (error instanceof ResearchLifecycleError && error.code === "invalid_transition") {
        res.status(409).json({
          error: error.message,
          details: { code: "INVALID_TRANSITION", retryable: false },
        });
        return;
      }
      rethrowAsApiError(error, "Failed to retry research run");
    }
  });

  router.get("/runs/:id/export", (req, res) => {
    try {
      const run = getStore().getRun(req.params.id);
      if (!run) throw notFound(`Run not found: ${req.params.id}`);

      const format = String(req.query.format ?? "markdown");
      if (format === "json") {
        res.json({ format, filename: `${run.id}.json`, content: JSON.stringify(run, null, 2) });
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

      const run = getStore().getRun(req.params.runId);
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

  router.post("/runs/:runId/findings/:findingId/tasks/:taskId/enrich", async (req, res) => {
    try {
      const scopedStore = requestContext.getStore();
      if (!scopedStore) throw new ApiError(500, "Task store context unavailable");

      const run = getStore().getRun(req.params.runId);
      if (!run) throw notFound(`Run not found: ${req.params.runId}`);
      const found = getFindingById(run, req.params.findingId);
      if (!found) throw notFound(`Finding not found: ${req.params.findingId}`);

      const task = await scopedStore.getTask(req.params.taskId);
      if (!task) throw notFound(`Task not found: ${req.params.taskId}`);
      if (task.column === "archived") throw new ApiError(409, "Cannot enrich archived task");

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

  router.post("/runs/:id/events", (req, res) => {
    try {
      const { type, message, metadata } = req.body ?? {};
      if (!RESEARCH_EVENT_TYPES.includes(type)) throw badRequest(`Invalid event type: ${String(type)}`);
      if (typeof message !== "string" || !message.trim()) throw badRequest("message is required");
      const event = getStore().appendEvent(req.params.id, { type, message, metadata });
      res.status(201).json(event);
    } catch (error) {
      rethrowAsApiError(error, "Failed to append research event");
    }
  });

  router.patch("/runs/:id", (req, res) => {
    try {
      const updated = getStore().updateRun(req.params.id, req.body ?? {});
      if (!updated) throw notFound(`Run not found: ${req.params.id}`);
      res.json(updated);
    } catch (error) {
      rethrowAsApiError(error, "Failed to update research run");
    }
  });

  router.delete("/runs/:id", (req, res) => {
    try {
      const deleted = getStore().deleteRun(req.params.id);
      if (!deleted) throw notFound(`Run not found: ${req.params.id}`);
      res.status(204).send();
    } catch (error) {
      rethrowAsApiError(error, "Failed to delete research run");
    }
  });

  router.post("/runs/:id/sources", (req, res) => {
    try {
      const { type, status } = req.body ?? {};
      if (!RESEARCH_SOURCE_TYPES.includes(type)) throw badRequest(`Invalid source type: ${String(type)}`);
      if (!RESEARCH_SOURCE_STATUSES.includes(status)) throw badRequest(`Invalid source status: ${String(status)}`);
      const source = getStore().addSource(req.params.id, req.body);
      res.status(201).json(source);
    } catch (error) {
      rethrowAsApiError(error, "Failed to add research source");
    }
  });

  router.patch("/runs/:id/sources/:sourceId", (req, res) => {
    try {
      getStore().updateSource(req.params.id, req.params.sourceId, req.body ?? {});
      res.status(204).send();
    } catch (error) {
      rethrowAsApiError(error, "Failed to update research source");
    }
  });

  router.put("/runs/:id/results", (req, res) => {
    try {
      getStore().setResults(req.params.id, req.body);
      res.status(204).send();
    } catch (error) {
      rethrowAsApiError(error, "Failed to set research results");
    }
  });

  router.patch("/runs/:id/status", (req, res) => {
    try {
      const status = req.body?.status as ResearchRunStatus | undefined;
      if (!status || !RESEARCH_RUN_STATUSES.includes(status)) throw badRequest(`Invalid status: ${String(status)}`);
      getStore().updateStatus(req.params.id, status, req.body?.extra);
      const run = getStore().getRun(req.params.id);
      if (!run) throw notFound(`Run not found: ${req.params.id}`);
      res.json(run);
    } catch (error) {
      rethrowAsApiError(error, "Failed to update research status");
    }
  });

  router.post("/runs/:id/exports", (req, res) => {
    try {
      const format = req.body?.format;
      const content = req.body?.content;
      if (typeof content !== "string") throw badRequest("content is required");
      const exportRow = getStore().createExport(req.params.id, format, content);
      res.status(201).json(exportRow);
    } catch (error) {
      rethrowAsApiError(error, "Failed to create research export");
    }
  });

  router.get("/runs/:id/exports", (req, res) => {
    try {
      res.json({ exports: getStore().getExports(req.params.id) });
    } catch (error) {
      rethrowAsApiError(error, "Failed to list research exports");
    }
  });

  router.get("/exports/:exportId", (req, res) => {
    try {
      const exportRow = getStore().getExport(req.params.exportId);
      if (!exportRow) throw notFound(`Export not found: ${req.params.exportId}`);
      res.json(exportRow);
    } catch (error) {
      rethrowAsApiError(error, "Failed to get research export");
    }
  });

  router.get("/stats", (_req, res) => {
    try {
      res.json(getStore().getStats());
    } catch (error) {
      rethrowAsApiError(error, "Failed to get research stats");
    }
  });

  router.get("/search", (req, res) => {
    try {
      const q = String(req.query.q ?? "").trim();
      if (!q) throw badRequest("q is required");
      res.json({ runs: getStore().searchRuns(q) });
    } catch (error) {
      rethrowAsApiError(error, "Failed to search research runs");
    }
  });

  return router;
}
