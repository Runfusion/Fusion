import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  RESEARCH_EXPORT_FORMATS,
  RESEARCH_RUN_STATUSES,
  ResearchRunStatus,
  type TaskStore,
  createTaskStoreForBackend,
  resolveResearchSettings,
  type ResearchExportFormat,
  type ResearchRun,
} from "@fusion/core";
import { ResearchOrchestrator, ResearchProviderRegistry, ResearchStepRunner } from "@fusion/engine";
import { resolveProjectPathOnly } from "../project-context.js";
import { retryOnLock } from "../lock-retry.js";

/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * FN-7740 audit finding: `getStore` resolved a name→path via a cached
 * `resolveProject(projectName)` call it never used `.store` from (path-only
 * leak), THEN always built a second, UNCACHED `new TaskStore(...)` that IS
 * the store actually used. NONE of `runResearchList`/`Show`/`Export`/
 * `Cancel`/`Retry` (or `runResearchCreate`'s `waitForCompletion` path)
 * closed either store on any exit path (success `return` or `handleError`
 * → `process.exit(1)`), leaking a SQLite/WAL handle that keeps the CLI
 * event loop alive after the command's work is done. Fixed by resolving the
 * name→path via `resolveProjectPathOnly` (closes+evicts the cached store
 * internally) and retaining the startup factory shutdown owner for every
 * caller. The non-wait create path persists a queued run and shuts down its
 * backend normally; the durable engine dispatcher executes that work. Discrete board/settings reads that gate run-critical
 * decisions (`getSettings()` in `getResearchRuntime`) and the `createExport`
 * write are wrapped in `retryOnLock` so a momentary `database is locked`
 * from an active engine/agent writer is retried instead of failing the
 * command outright.
 */
async function withResolvedStore<T>(
  projectName: string | undefined,
  fn: (store: TaskStore) => Promise<T>,
): Promise<T> {
  const owned = await getStore(projectName);
  try {
    return await fn(owned.store);
  } finally {
    await owned.shutdown();
  }
}

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

/*
FNXC:ResearchCliPostgres 2026-07-13-22:38:
Research CLI execution, lifecycle commands, and exports must use the TaskStore-selected backend. Both ResearchStore and AsyncResearchStore expose the same API; callers await every operation so PostgreSQL promises and legacy synchronous returns preserve identical operator behavior.
*/
interface OwnedResearchStore {
  store: TaskStore;
  shutdown: () => Promise<void>;
}

async function getStore(projectName?: string): Promise<OwnedResearchStore> {
  const projectPath = projectName ? await resolveProjectPathOnly(projectName) : undefined;
  const rootDir = projectPath ?? process.cwd();
  // FNXC:PostgresFinalCutover 2026-07-14-17:20: Research always borrows the
  // non-null PostgreSQL TaskStore returned by the startup factory.
  const boot = await createTaskStoreForBackend({ rootDir });
  /* FNXC:PostgresCliLifecycle 2026-07-14-19:10: Research commands retain the full startup owner, not only TaskStore, because embedded PostgreSQL teardown belongs to BackendBootResult.shutdown. */
  return { store: boot.taskStore, shutdown: boot.shutdown };
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
  const settings = await retryOnLock(() => store.getSettings(), { id: "research", action: "read research settings" });
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
  /*
   * FNXC:CliBoardMutation 2026-07-09-00:00:
   * Closes the store explicitly BEFORE every exit point rather than via a
   * try/finally wrapping `handleError` — per project memory, `process.exit()`
   * does NOT run pending `finally` blocks in production (only a *mocked*
   * `process.exit` in tests throws, which would misleadingly make a
   * `finally` after `handleError` appear to work under test but not for
   * real). EVERY exit point below invokes the startup factory's shutdown owner
   * before returning or exiting; only the explicit wait path starts and drains
   * in-process orchestrator work.
   */
  let owned: OwnedResearchStore | undefined;
  let store: TaskStore | undefined;
  const closeStore = async (): Promise<void> => {
    if (!owned) return;
    const current = owned;
    owned = undefined;
    await current.shutdown();
  };

  try {
    owned = await getStore(options.projectName);
    store = owned.store;
    const { orchestrator, settings, resolved, availableProviderTypes } = await getResearchRuntime(store);

    const runId = await orchestrator.createRun({
      providers: availableProviderTypes
        .filter((type) => type !== "llm-synthesis")
        .map((type) => ({ type, config: { maxResults: resolved.limits.maxSourcesPerRun, timeoutMs: resolved.limits.requestTimeoutMs } })),
      maxSources: resolved.limits.maxSourcesPerRun,
      maxSynthesisRounds: Math.max(1, settings.researchMaxSynthesisRounds ?? settings.researchGlobalMaxSynthesisRounds ?? 2),
      phaseTimeoutMs: resolved.limits.maxDurationMs,
      stepTimeoutMs: resolved.limits.requestTimeoutMs,
    });

    await store.getResearchStore().updateRun(runId, { query: options.query });
    if (!options.waitForCompletion) {
      /*
      FNXC:ResearchCliDurableDispatch 2026-07-14-22:54:
      A non-wait CLI invocation persists a query-bearing queued run and exits after normal backend shutdown. It must not start in-process work or retain PostgreSQL ownership; the durable engine ResearchRunDispatcher owns queued execution after the short-lived CLI process exits.
      */
      const run = await store.getResearchStore().getRun(runId);
      await closeStore();
      if (options.json) {
        jsonOut(run);
      } else {
        console.log(`Created cited-research run ${runId}.`);
        if (run) printRun(run);
      }
      return;
    }

    const runPromise = orchestrator.startRun(runId, options.query);
    const maxWaitMs = Math.max(1_000, Math.min(options.maxWaitMs ?? 90_000, resolved.limits.maxDurationMs));
    const fallbackRun = (): ResearchRun => ({
          id: runId,
          query: options.query,
          status: "running",
          sources: [],
          events: [],
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let didTimeout = false;
    /*
    FNXC:ResearchCliPostgres 2026-07-13-23:05:
    The completion timeout must be cancelled when the run finishes first; otherwise its later asynchronous PostgreSQL read races the store close and can reject without a handler. If the timeout read itself fails, return the same running snapshot used when no persisted run is available.
    */
    const timeoutResult = new Promise<ResearchRun>((resolveRun) => {
      timeout = setTimeout(() => {
        didTimeout = true;
        void Promise.resolve(store!.getResearchStore().getRun(runId))
          .then((latest) => resolveRun(latest ?? fallbackRun()))
          .catch(() => resolveRun(fallbackRun()));
      }, maxWaitMs);
    });
    let completed = await Promise.race([runPromise, timeoutResult]);
    if (timeout) clearTimeout(timeout);

    /*
    FNXC:ResearchCliPostgres 2026-07-13-23:52:
    A CLI completion timeout is also an ownership boundary: cancel and await the active orchestrator before closing its PostgreSQL pool. Closing the store while the run still persists phases can corrupt lifecycle state and surface late unhandled rejections.
    */
    if (didTimeout) {
      await orchestrator.cancelRun(runId);
      await runPromise.catch(() => undefined);
      completed = (await store.getResearchStore().getRun(runId)) ?? completed;
    }

    // The wait-path run either completed or was cancelled and drained above.
    await closeStore();

    if (options.json) {
      jsonOut(completed);
    } else {
      printRun(completed);
    }
  } catch (error) {
    await closeStore();
    handleError(error);
  }
}

export async function runResearchList(options: ResearchListOptions = {}): Promise<void> {
  try {
    await withResolvedStore(options.projectName, async (store) => {
      if (options.status && !RESEARCH_RUN_STATUSES.includes(options.status as ResearchRunStatus)) {
        throw new Error(`Invalid status: ${options.status}`);
      }

      const runs = await store.getResearchStore().listRuns({
        status: options.status as ResearchRunStatus | undefined,
        limit: options.limit ? Math.max(1, options.limit) : 20,
      });

      if (options.json) {
        jsonOut({ runs });
        return;
      }

      if (!runs.length) {
        console.log("No cited-research runs found.");
        return;
      }

      for (const run of runs) {
        console.log(`${run.id}  [${run.status}]  ${run.query}`);
      }
    });
  } catch (error) {
    handleError(error);
  }
}

export async function runResearchShow(runId: string, options: ResearchCommandOptions = {}): Promise<void> {
  try {
    await withResolvedStore(options.projectName, async (store) => {
      const run = await store.getResearchStore().getRun(runId);
      if (!run) throw new Error(`Cited-research run not found: ${runId}`);

      if (options.json) {
        jsonOut(run);
        return;
      }
      printRun(run);
    });
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
    await withResolvedStore(options.projectName, async (store) => {
      const run = await store.getResearchStore().getRun(options.runId);
      if (!run) throw new Error(`Cited-research run not found: ${options.runId}`);

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
      await retryOnLock(
        async () => store.getResearchStore().createExport(run.id, format, content),
        { id: run.id, action: "export research run" },
      );

      if (options.json) {
        jsonOut({ runId: run.id, format, outputPath, bytes: Buffer.byteLength(content, "utf8") });
        return;
      }

      console.log(`Exported ${run.id} (${format}) to ${outputPath}`);
    });
  } catch (error) {
    handleError(error);
  }
}

export async function runResearchCancel(runId: string, options: ResearchCommandOptions = {}): Promise<void> {
  try {
    await withResolvedStore(options.projectName, async (store) => {
      const run = await store.getResearchStore().getRun(runId);
      if (!run) throw new Error(`Cited-research run not found: ${runId}`);

      if (!["queued", "running", "cancelling", "retry_waiting"].includes(run.status)) {
        throw new Error(`invalid-transition: Run ${runId} cannot be cancelled from status ${run.status}.`);
      }

      const { orchestrator } = await getResearchRuntime(store);
      const cancelled = await orchestrator.cancelRun(runId);

      if (options.json) {
        jsonOut({ cancelled, run });
        return;
      }

      console.log(cancelled ? `Cancellation requested for ${runId}.` : `Run ${runId} is not active.`);
      printRun(run);
    });
  } catch (error) {
    handleError(error);
  }
}

export async function runResearchRetry(runId: string, options: ResearchCommandOptions = {}): Promise<void> {
  try {
    await withResolvedStore(options.projectName, async (store) => {
      const existing = await store.getResearchStore().getRun(runId);
      if (!existing) throw new Error(`Cited-research run not found: ${runId}`);

      if (existing.status === "retry_exhausted" || existing.lifecycle?.errorCode === "RETRY_EXHAUSTED") {
        throw new Error(`retry-exhausted: Run ${runId} has exhausted retry attempts.`);
      }
      if (existing.lifecycle?.retryable === false) {
        throw new Error(`non-retryable-provider-error: Run ${runId} is marked non-retryable.`);
      }

      // `retryRun` only creates a new run row (does not call `startRun`), so
      // unlike `runResearchCreate`'s fire-and-forget branch there is no
      // background execution in flight here — safe to close the store below.
      const { orchestrator } = await getResearchRuntime(store);
      const newRunId = await orchestrator.retryRun(runId);
      const run = await store.getResearchStore().getRun(newRunId);

      if (options.json) {
        jsonOut({ retryOf: runId, run });
        return;
      }

      console.log(`Created retry run ${newRunId} from ${runId}.`);
      if (run) printRun(run);
    });
  } catch (error) {
    handleError(error);
  }
}
