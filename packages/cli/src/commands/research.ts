import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  RESEARCH_EXPORT_FORMATS,
  RESEARCH_RUN_STATUSES,
  ResearchRunStatus,
  TaskStore,
  resolveResearchSettings,
  type ResearchExportFormat,
  type ResearchRun,
} from "@fusion/core";
import { ResearchOrchestrator, ResearchProviderRegistry, ResearchStepRunner } from "@fusion/engine";
import { resolveProject } from "../project-context.js";

interface ResearchCommandOptions {
  projectName?: string;
  json?: boolean;
}

interface ResearchCreateOptions extends ResearchCommandOptions {
  query: string;
  waitForCompletion?: boolean;
  maxWaitMs?: number;
}

interface ResearchListOptions extends ResearchCommandOptions {
  status?: string;
  limit?: number;
}

interface ResearchExportOptions extends ResearchCommandOptions {
  runId: string;
  format?: string;
  output?: string;
}

async function getStore(projectName?: string): Promise<TaskStore> {
  const project = projectName ? await resolveProject(projectName) : undefined;
  const store = new TaskStore(project?.projectPath ?? process.cwd());
  await store.init();
  return store;
}

function hasProviderCredentials(settings: Awaited<ReturnType<TaskStore["getSettings"]>>, providerId: string | undefined): boolean {
  if (!providerId || providerId === "builtin") return true;
  if (providerId === "searxng") return Boolean(settings.researchGlobalSearxngUrl);
  if (providerId === "brave") return Boolean(settings.researchGlobalBraveApiKey);
  if (providerId === "google") return Boolean(settings.researchGlobalGoogleSearchApiKey && settings.researchGlobalGoogleSearchCx);
  if (providerId === "tavily") return Boolean(settings.researchGlobalTavilyApiKey);
  return false;
}

async function getResearchRuntime(store: TaskStore) {
  const settings = await store.getSettings();
  const resolved = resolveResearchSettings(settings);
  if (!resolved.enabled) {
    throw new Error("feature-disabled: Research is disabled in settings.");
  }

  const configuredProvider = (resolved.searchProvider as string | undefined) ?? settings.researchGlobalWebSearchProvider ?? "builtin";
  if (configuredProvider !== "builtin" && !hasProviderCredentials(settings, configuredProvider)) {
    throw new Error(`missing-credentials: ${configuredProvider} credentials are missing. Configure Authentication and Research defaults in settings.`);
  }

  const registry = new ResearchProviderRegistry(settings, process.cwd());
  const availableProviderTypes = registry.getAvailableProviders();
  if (availableProviderTypes.length === 0) {
    throw new Error("provider-unavailable: Research providers are not configured. Add provider credentials in settings.");
  }

  const stepRunner = new ResearchStepRunner({
    providers: availableProviderTypes
      .map((type) => registry.getProvider(type))
      .filter((provider): provider is NonNullable<typeof provider> => Boolean(provider)),
  });

  const orchestrator = new ResearchOrchestrator({
    store: store.getResearchStore(),
    stepRunner,
    maxConcurrentRuns: resolved.limits.maxConcurrentRuns,
  });

  return { orchestrator, settings, resolved, availableProviderTypes };
}

function printRun(run: ResearchRun): void {
  console.log(`Run:       ${run.id}`);
  console.log(`Status:    ${run.status}`);
  console.log(`Query:     ${run.query}`);
  console.log(`Created:   ${run.createdAt}`);
  console.log(`Updated:   ${run.updatedAt}`);
  if (run.startedAt) console.log(`Started:   ${run.startedAt}`);
  if (run.completedAt) console.log(`Completed: ${run.completedAt}`);
  if (run.cancelledAt) console.log(`Cancelled: ${run.cancelledAt}`);
  if (run.results?.summary) console.log(`Summary:   ${run.results.summary}`);
  if (run.error) console.log(`Error:     ${run.error}`);
}

function jsonOut(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function handleError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}

export async function runResearchCreate(options: ResearchCreateOptions): Promise<void> {
  try {
    const store = await getStore(options.projectName);
    const { orchestrator, settings, resolved, availableProviderTypes } = await getResearchRuntime(store);

    const runId = orchestrator.createRun({
      providers: availableProviderTypes
        .filter((type) => type !== "llm-synthesis")
        .map((type) => ({ type, config: { maxResults: resolved.limits.maxSourcesPerRun, timeoutMs: resolved.limits.requestTimeoutMs } })),
      maxSources: resolved.limits.maxSourcesPerRun,
      maxSynthesisRounds: Math.max(1, settings.researchMaxSynthesisRounds ?? settings.researchGlobalMaxSynthesisRounds ?? 2),
      phaseTimeoutMs: resolved.limits.maxDurationMs,
      stepTimeoutMs: resolved.limits.requestTimeoutMs,
    });

    const runPromise = orchestrator.startRun(runId, options.query);
    if (!options.waitForCompletion) {
      const run = store.getResearchStore().getRun(runId);
      if (options.json) {
        jsonOut(run);
      } else {
        console.log(`Created research run ${runId}.`);
        if (run) printRun(run);
      }
      return;
    }

    const maxWaitMs = Math.max(1_000, Math.min(options.maxWaitMs ?? 90_000, resolved.limits.maxDurationMs));
    const completed = await Promise.race([
      runPromise,
      new Promise<ResearchRun>((resolveRun) => setTimeout(() => {
        const latest = store.getResearchStore().getRun(runId);
        resolveRun(latest ?? ({
          id: runId,
          query: options.query,
          status: "running",
          sources: [],
          events: [],
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as ResearchRun));
      }, maxWaitMs)),
    ]);

    if (options.json) {
      jsonOut(completed);
    } else {
      printRun(completed);
    }
  } catch (error) {
    handleError(error);
  }
}

export async function runResearchList(options: ResearchListOptions = {}): Promise<void> {
  try {
    const store = await getStore(options.projectName);
    if (options.status && !RESEARCH_RUN_STATUSES.includes(options.status as ResearchRunStatus)) {
      throw new Error(`Invalid status: ${options.status}`);
    }

    const runs = store.getResearchStore().listRuns({
      status: options.status as ResearchRunStatus | undefined,
      limit: options.limit ? Math.max(1, options.limit) : 20,
    });

    if (options.json) {
      jsonOut({ runs });
      return;
    }

    if (!runs.length) {
      console.log("No research runs found.");
      return;
    }

    for (const run of runs) {
      console.log(`${run.id}  [${run.status}]  ${run.query}`);
    }
  } catch (error) {
    handleError(error);
  }
}

export async function runResearchShow(runId: string, options: ResearchCommandOptions = {}): Promise<void> {
  try {
    const store = await getStore(options.projectName);
    const run = store.getResearchStore().getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);

    if (options.json) {
      jsonOut(run);
      return;
    }
    printRun(run);
  } catch (error) {
    handleError(error);
  }
}

function renderMarkdown(run: ResearchRun): string {
  const citations = run.results?.citations?.length
    ? `\n## Citations\n${run.results.citations.map((citation) => `- ${citation}`).join("\n")}`
    : "";
  return `# ${run.topic || run.query}\n\n## Summary\n${run.results?.summary ?? ""}${citations}\n`;
}

export async function runResearchExport(options: ResearchExportOptions): Promise<void> {
  try {
    const store = await getStore(options.projectName);
    const run = store.getResearchStore().getRun(options.runId);
    if (!run) throw new Error(`Research run not found: ${options.runId}`);

    const format = (options.format ?? "markdown") as ResearchExportFormat;
    if (!RESEARCH_EXPORT_FORMATS.includes(format)) {
      throw new Error(`Unsupported export format: ${format}`);
    }

    const content = format === "json" ? JSON.stringify(run, null, 2) : renderMarkdown(run);
    const ext = format === "json" ? "json" : "md";
    const outputPath = options.output
      ? resolve(options.output)
      : join(process.cwd(), `research-${run.id.toLowerCase()}.${ext}`);

    await writeFile(outputPath, content, "utf8");
    store.getResearchStore().createExport(run.id, format, content);

    if (options.json) {
      jsonOut({ runId: run.id, format, outputPath, bytes: Buffer.byteLength(content, "utf8") });
      return;
    }

    console.log(`Exported ${run.id} (${format}) to ${outputPath}`);
  } catch (error) {
    handleError(error);
  }
}

export async function runResearchCancel(runId: string, options: ResearchCommandOptions = {}): Promise<void> {
  try {
    const store = await getStore(options.projectName);
    const run = store.getResearchStore().getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);

    if (!["queued", "running", "cancelling", "retry_waiting"].includes(run.status)) {
      throw new Error(`invalid-transition: Run ${runId} cannot be cancelled from status ${run.status}.`);
    }

    const { orchestrator } = await getResearchRuntime(store);
    const cancelled = orchestrator.cancelRun(runId);

    if (options.json) {
      jsonOut({ cancelled, run });
      return;
    }

    console.log(cancelled ? `Cancellation requested for ${runId}.` : `Run ${runId} is not active.`);
    printRun(run);
  } catch (error) {
    handleError(error);
  }
}

export async function runResearchRetry(runId: string, options: ResearchCommandOptions = {}): Promise<void> {
  try {
    const store = await getStore(options.projectName);
    const existing = store.getResearchStore().getRun(runId);
    if (!existing) throw new Error(`Research run not found: ${runId}`);

    if (existing.status === "retry_exhausted" || existing.lifecycle?.errorCode === "RETRY_EXHAUSTED") {
      throw new Error(`retry-exhausted: Run ${runId} has exhausted retry attempts.`);
    }
    if (existing.lifecycle?.retryable === false) {
      throw new Error(`non-retryable-provider-error: Run ${runId} is marked non-retryable.`);
    }

    const { orchestrator } = await getResearchRuntime(store);
    const newRunId = orchestrator.retryRun(runId);
    const run = store.getResearchStore().getRun(newRunId);

    if (options.json) {
      jsonOut({ retryOf: runId, run });
      return;
    }

    console.log(`Created retry run ${newRunId} from ${runId}.`);
    if (run) printRun(run);
  } catch (error) {
    handleError(error);
  }
}
