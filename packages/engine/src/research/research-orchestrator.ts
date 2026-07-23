import type { AsyncResearchStore, ResearchStore } from "@fusion/core";
import type {
  ResearchCancellationState,
  ResearchOrchestrationConfig,
  ResearchOrchestrationPhase,
  ResearchOrchestrationStep,
  ResearchRun,
  ResearchSource,
  ResearchSynthesisRequest,
} from "@fusion/core";
import { AgentSemaphore } from "../concurrency/concurrency.js";
import { createLogger, formatError } from "../logger.js";
import type { ResearchStepRunnerApi } from "./research-step-runner.js";

const log = createLogger("research-orchestrator");

/*
 * FNXC:ResearchStore 2026-06-28-11:30:
 * Research run EXECUTION must drive both backends: the sync SQLite EventEmitter
 * `ResearchStore` and the PostgreSQL-backed `AsyncResearchStore` (async). Both
 * expose the same store method names/shapes, so the orchestrator types `store` as
 * the union and `await`s every store call — a sync method's awaited return is
 * identical to its direct return, so lifecycle semantics are preserved across both
 * backends. Mirrors the InsightRunExecutor union+await port. Note: the async store
 * exposes `appendEvent` (not the sync-only `addEvent`), so all event writes here go
 * through `appendEvent`, which the sync store also implements as an alias.
 */
export type ResearchExecutorStore = ResearchStore | AsyncResearchStore;

export interface ResearchOrchestratorStatus {
  runId: string;
  status: ResearchRun["status"];
  phase: ResearchOrchestrationPhase;
  stepIndex: number;
  totalSteps: number;
  progress: number;
  active: boolean;
}

export interface ResearchOrchestratorStartOptions {
  abortSignal?: AbortSignal;
}

export interface ResearchOrchestratorOptions {
  store: ResearchExecutorStore;
  stepRunner: ResearchStepRunnerApi;
  maxConcurrentRuns?: number;
}

interface ActiveRunState {
  controller: AbortController;
  phase: ResearchOrchestrationPhase;
  stepIndex: number;
  totalSteps: number;
  config: ResearchOrchestrationConfig;
  cancellationTimer?: NodeJS.Timeout;
}

const CANCELLATION_GRACE_MS = 2_000;

export class ResearchOrchestrator {
  private readonly store: ResearchExecutorStore;
  private readonly stepRunner: ResearchStepRunnerApi;
  private readonly semaphore: AgentSemaphore;
  private readonly activeRuns = new Map<string, ActiveRunState>();
  private readonly cancellation = new Map<string, ResearchCancellationState>();

  constructor(options: ResearchOrchestratorOptions) {
    this.store = options.store;
    this.stepRunner = options.stepRunner;
    this.semaphore = new AgentSemaphore(options.maxConcurrentRuns ?? 3);
  }

  async createRun(config: ResearchOrchestrationConfig): Promise<string> {
    const run = await this.store.createRun({
      query: "",
      providerConfig: config as unknown as Record<string, unknown>,
      metadata: {
        orchestration: {
          phase: "planning",
          stepIndex: 0,
          totalSteps: this.computeTotalSteps(config),
        },
      },
    });
    return run.id;
  }

  async startRun(runId: string, query: string, options: ResearchOrchestratorStartOptions = {}): Promise<ResearchRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);

    const config = this.normalizeConfig(run.providerConfig);
    const controller = new AbortController();
    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", () => controller.abort(options.abortSignal?.reason), { once: true });
    }

    const totalSteps = this.computeTotalSteps(config);
    this.activeRuns.set(runId, {
      controller,
      phase: "planning",
      stepIndex: 0,
      totalSteps,
      config,
    });

    const queued = await this.store.getRun(runId);
    if (queued?.status === "retry_waiting") {
      await this.store.updateStatus(runId, "queued");
    }

    await this.semaphore.run(async () => {
      await this.store.updateRun(runId, { query, startedAt: new Date().toISOString(), error: null });
      await this.store.updateStatus(runId, "running");
      await this.runPhases(runId, query, config, controller.signal);
    });

    const updated = await this.store.getRun(runId);
    if (!updated) throw new Error(`Research run not found after start: ${runId}`);
    return updated;
  }

  async cancelRun(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    const run = await this.store.getRun(runId);
    if (!run) return false;
    await this.store.requestCancellation(runId);

    if (!active) {
      await this.store.updateStatus(runId, "cancelled", { error: "Cancelled by user" });
      return true;
    }

    if (active.cancellationTimer) return true;

    const state: ResearchCancellationState = {
      runId,
      controller: active.controller,
      requestedAt: new Date().toISOString(),
      gracefulShutdown: true,
      reason: "Cancelled by user",
    };
    this.cancellation.set(runId, state);
    active.controller.abort(new Error("Research run cancelled"));
    active.cancellationTimer = setTimeout(() => {
      void this.onCancelled(runId);
    }, CANCELLATION_GRACE_MS);
    return true;
  }

  async retryRun(runId: string): Promise<string> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new Error(`Research run ${runId} is not retryable (status=${run.status})`);
    }

    const next = await this.store.createRun({
      query: run.query,
      topic: run.topic,
      providerConfig: run.providerConfig,
      tags: [...run.tags],
      metadata: {
        ...(run.metadata ?? {}),
        retryOfRunId: run.id,
      },
    });
    await this.store.appendEvent(next.id, {
      type: "info",
      message: `Retry run created from ${run.id}`,
      metadata: { retryOfRunId: run.id },
    });
    return next.id;
  }

  async getRunStatus(runId: string): Promise<ResearchOrchestratorStatus> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);

    const active = this.activeRuns.get(runId);
    const metadata = (run.metadata?.orchestration as Record<string, unknown> | undefined) ?? {};
    const phase = (active?.phase ?? metadata.phase ?? this.statusToPhase(run.status)) as ResearchOrchestrationPhase;
    const stepIndex = active?.stepIndex ?? Number(metadata.stepIndex ?? 0);
    const totalSteps = active?.totalSteps ?? Number(metadata.totalSteps ?? 0);

    return {
      runId,
      status: run.status,
      phase,
      stepIndex,
      totalSteps,
      progress: totalSteps > 0 ? Math.min(1, stepIndex / totalSteps) : 0,
      active: this.activeRuns.has(runId),
    };
  }

  private async runPhases(
    runId: string,
    query: string,
    config: ResearchOrchestrationConfig,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.runPlanning(runId, query, config, signal);
      const sources = await this.runSearching(runId, query, config, signal);
      const fetchedSources = await this.runFetching(runId, sources, config, signal);
      const synthesis = await this.runSynthesis(runId, query, fetchedSources, config, signal);
      await this.runFinalizing(runId, synthesis.output, synthesis.citations, synthesis.confidence, signal);

      await this.store.updateStatus(runId, "completed");
      await this.transitionPhase(runId, "completed", "Research run completed");
    } catch (err) {
      if (signal.aborted) {
        await this.onCancelled(runId);
      } else {
        const { message, detail } = formatError(err);
        await this.store.appendEvent(runId, {
          type: "error",
          message: `Research run failed: ${message}`,
          metadata: { detail },
        });
        await this.store.updateStatus(runId, "failed", { error: message });
        await this.transitionPhase(runId, "failed", "Research run failed", { error: message });
      }
    } finally {
      const active = this.activeRuns.get(runId);
      if (active?.cancellationTimer) {
        clearTimeout(active.cancellationTimer);
      }
      this.activeRuns.delete(runId);
      this.cancellation.delete(runId);
    }
  }

  private async runPlanning(runId: string, query: string, config: ResearchOrchestrationConfig, _signal: AbortSignal): Promise<void> {
    await this.transitionPhase(runId, "planning", "Planning research execution");
    await this.stepStarted(runId, {
      id: `${runId}-planning`,
      type: "synthesis-pass",
      phase: "planning",
      status: "running",
      order: 0,
      name: "Create plan",
      input: { query, providerCount: config.providers.length },
      startedAt: new Date().toISOString(),
    });
    await this.stepCompleted(runId, `${runId}-planning`, { query });
  }

  private async runSearching(
    runId: string,
    query: string,
    config: ResearchOrchestrationConfig,
    signal: AbortSignal,
  ): Promise<ResearchSource[]> {
    this.throwIfAborted(signal);
    await this.transitionPhase(runId, "searching", "Searching sources");

    const allSources: ResearchSource[] = [];
    for (const provider of config.providers) {
      this.throwIfAborted(signal);
      const step = this.createStep(runId, "source-query", "searching", `Search with ${provider.type}`, {
        query,
        provider: provider.type,
      });
      await this.stepStarted(runId, step);

      const result = await this.stepRunner.runSourceQuery(query, provider.type, provider.config, signal);
      if (!result.ok || !result.data) {
        await this.stepFailed(runId, step.id, result.error?.message ?? `Provider ${provider.type} returned no data`, result.error);
        continue;
      }

      for (const source of result.data.slice(0, Math.max(0, config.maxSources - allSources.length))) {
        const saved = await this.store.addSource(runId, {
        ...source,
        metadata: {
          ...(source.metadata ?? {}),
          providerType: provider.type,
        },
      });
        allSources.push(saved);
        await this.store.appendEvent(runId, {
          type: "source_added",
          message: `Source found: ${saved.reference}`,
          metadata: { sourceId: saved.id, provider: provider.type },
        });
      }

      await this.stepCompleted(runId, step.id, { sourceCount: result.data.length });
      if (allSources.length >= config.maxSources) break;
    }

    if (allSources.length === 0) {
      throw new Error("No sources discovered during search phase");
    }

    return allSources;
  }

  private async runFetching(
    runId: string,
    sources: ResearchSource[],
    config: ResearchOrchestrationConfig,
    signal: AbortSignal,
  ): Promise<ResearchSource[]> {
    this.throwIfAborted(signal);
    await this.transitionPhase(runId, "fetching", "Fetching source content");

    const fetched: ResearchSource[] = [];
    const provider = config.providers[0];
    for (const source of sources.slice(0, config.maxSources)) {
      this.throwIfAborted(signal);
      const step = this.createStep(runId, "content-fetch", "fetching", `Fetch ${source.reference}`, {
        sourceId: source.id,
      });
      await this.stepStarted(runId, step);

      const sourceProvider = this.getSourceProviderType(source);
      const providerConfig = sourceProvider ? config.providers.find((p) => p.type === sourceProvider)?.config : provider?.config;
      const result = await this.stepRunner.runContentFetch(source.reference, sourceProvider, providerConfig, signal);
      if (!result.ok || !result.data) {
        await this.stepFailed(runId, step.id, result.error?.message ?? "Failed to fetch source content", result.error);
        continue;
      }

      const updated: ResearchSource = {
        ...source,
        content: result.data.content,
        metadata: {
          ...(source.metadata ?? {}),
          ...(result.data.metadata ?? {}),
        },
        status: "completed",
        fetchedAt: new Date().toISOString(),
      };
      await this.store.updateSource(runId, source.id, updated);
      fetched.push(updated);
      await this.stepCompleted(runId, step.id, { fetched: true });
    }

    if (fetched.length === 0) {
      throw new Error("No source content fetched");
    }

    return fetched;
  }

  private async runSynthesis(
    runId: string,
    query: string,
    sources: ResearchSource[],
    config: ResearchOrchestrationConfig,
    signal: AbortSignal,
  ): Promise<{ output: string; citations: string[]; confidence?: number }> {
    this.throwIfAborted(signal);
    await this.transitionPhase(runId, "synthesizing", "Synthesizing findings");

    let final: { output: string; citations: string[]; confidence?: number } | undefined;

    for (let round = 1; round <= Math.max(1, config.maxSynthesisRounds); round++) {
      this.throwIfAborted(signal);
      const step = this.createStep(runId, "synthesis-pass", "synthesizing", `Synthesis round ${round}`, {
        round,
      });
      await this.stepStarted(runId, step);

      const request: ResearchSynthesisRequest = {
        query,
        sources,
        round,
        desiredFormat: "markdown",
      };
      const result = await this.stepRunner.runSynthesis(request, config.synthesisModel, signal);
      if (!result.ok || !result.data) {
        await this.stepFailed(runId, step.id, result.error?.message ?? "Synthesis failed", result.error);
        continue;
      }

      final = result.data;
      await this.store.appendEvent(runId, {
        type: "progress",
        message: `Synthesis round ${round} completed`,
        metadata: { round, confidence: result.data.confidence },
      });
      await this.stepCompleted(runId, step.id, { round, citations: result.data.citations.length });
    }

    if (!final) {
      throw new Error("All synthesis rounds failed");
    }

    return final;
  }

  private async runFinalizing(
    runId: string,
    output: string,
    citations: string[],
    confidence: number | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    this.throwIfAborted(signal);
    await this.transitionPhase(runId, "finalizing", "Finalizing research results");
    if (!(await this.canWriteRunData(runId))) return;
    await this.store.setResults(runId, {
      summary: output,
      findings: [
        {
          heading: "Synthesis",
          content: output,
          sources: citations,
          confidence,
        },
      ],
      citations,
      synthesizedOutput: output,
    });
  }

  private async onCancelled(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run || run.status === "cancelled") return;
    const cancellation = this.cancellation.get(runId);
    await this.store.appendEvent(runId, {
      type: "warning",
      message: "Research run cancelled",
      metadata: {
        requestedAt: cancellation?.requestedAt,
        reason: cancellation?.reason,
      },
    });
    await this.store.updateStatus(runId, "cancelled", {
      cancelledAt: new Date().toISOString(),
      error: cancellation?.reason,
    });
    await this.transitionPhase(runId, "cancelled", "Research run cancelled");
  }

  private async transitionPhase(
    runId: string,
    phase: ResearchOrchestrationPhase,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!(await this.canWriteRunData(runId)) && phase !== "cancelled" && phase !== "completed" && phase !== "failed") return;
    const active = this.activeRuns.get(runId);
    if (active) {
      active.phase = phase;
    }
    await this.store.updateRun(runId, {
      metadata: {
        orchestration: {
          phase,
          stepIndex: active?.stepIndex ?? 0,
          totalSteps: active?.totalSteps ?? 0,
        },
      },
    });
    await this.store.appendEvent(runId, {
      type: "progress",
      message,
      metadata: {
        orchestrationEventType: "phase-changed",
        phase,
        ...(metadata ?? {}),
      },
    });
    log.log(`${runId}: phase changed -> ${phase}`);
  }

  private async stepStarted(runId: string, step: ResearchOrchestrationStep): Promise<void> {
    if (!(await this.canWriteRunData(runId))) return;
    await this.bumpStep(runId, step.order);
    await this.store.appendEvent(runId, {
      type: "progress",
      message: `${step.name} started`,
      metadata: {
        orchestrationEventType: "step-started",
        step,
      },
    });
  }

  private async stepCompleted(runId: string, stepId: string, output?: Record<string, unknown>): Promise<void> {
    if (!(await this.canWriteRunData(runId))) return;
    await this.store.appendEvent(runId, {
      type: "progress",
      message: `${stepId} completed`,
      metadata: {
        orchestrationEventType: "step-completed",
        stepId,
        output,
      },
    });
  }

  private async stepFailed(
    runId: string,
    stepId: string,
    errorMessage: string,
    errorMeta?: Record<string, unknown>,
  ): Promise<void> {
    if (!(await this.canWriteRunData(runId))) return;
    await this.store.appendEvent(runId, {
      type: "error",
      message: `${stepId} failed: ${errorMessage}`,
      metadata: {
        orchestrationEventType: "step-failed",
        stepId,
        ...(errorMeta ?? {}),
      },
    });
  }

  private async bumpStep(runId: string, stepIndex: number): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.stepIndex = stepIndex;
    await this.store.updateRun(runId, {
      metadata: {
        orchestration: {
          phase: active.phase,
          stepIndex: active.stepIndex,
          totalSteps: active.totalSteps,
        },
      },
    });
  }

  private createStep(
    runId: string,
    type: ResearchOrchestrationStep["type"],
    phase: ResearchOrchestrationPhase,
    name: string,
    input?: Record<string, unknown>,
  ): ResearchOrchestrationStep {
    const active = this.activeRuns.get(runId);
    const order = (active?.stepIndex ?? 0) + 1;
    return {
      id: `${runId}-${phase}-${order}`,
      type,
      phase,
      status: "running",
      order,
      name,
      input,
      startedAt: new Date().toISOString(),
    };
  }

  private computeTotalSteps(config: ResearchOrchestrationConfig): number {
    const providers = Math.max(1, config.providers.length);
    return 1 + providers + Math.max(1, config.maxSources) + Math.max(1, config.maxSynthesisRounds) + 1;
  }

  private normalizeConfig(rawConfig: ResearchRun["providerConfig"]): ResearchOrchestrationConfig {
    const raw = (rawConfig ?? {}) as Record<string, unknown>;
    const rawProviders = Array.isArray(raw.providers) ? raw.providers : [];
    const providers = rawProviders
      .map((provider): ResearchOrchestrationConfig["providers"][number] | null => {
        if (typeof provider === "string") {
          const type = provider.trim();
          return type && type !== "llm-synthesis" ? { type } : null;
        }
        if (provider && typeof provider === "object") {
          const candidate = provider as { type?: unknown; config?: unknown };
          if (typeof candidate.type === "string" && candidate.type.trim() && candidate.type !== "llm-synthesis") {
            return {
              type: candidate.type.trim(),
              config: candidate.config && typeof candidate.config === "object"
                ? candidate.config as ResearchOrchestrationConfig["providers"][number]["config"]
                : undefined,
            };
          }
        }
        return null;
      })
      .filter((provider): provider is ResearchOrchestrationConfig["providers"][number] => Boolean(provider));

    const maxSources = this.positiveNumber(raw.maxSources) ?? this.positiveNumber(raw.maxResults) ?? 20;
    const maxSynthesisRounds = this.positiveNumber(raw.maxSynthesisRounds) ?? 2;

    return {
      providers: providers.length ? providers : [{ type: "web-search" }],
      maxSources,
      maxSynthesisRounds,
      phaseTimeoutMs: this.positiveNumber(raw.phaseTimeoutMs),
      stepTimeoutMs: this.positiveNumber(raw.stepTimeoutMs),
      rateLimitPerMinute: this.positiveNumber(raw.rateLimitPerMinute),
      synthesisModel: raw.synthesisModel && typeof raw.synthesisModel === "object"
        ? raw.synthesisModel as ResearchOrchestrationConfig["synthesisModel"]
        : undefined,
      metadata: raw.metadata && typeof raw.metadata === "object"
        ? raw.metadata as Record<string, unknown>
        : undefined,
    };
  }

  private positiveNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private statusToPhase(status: ResearchRun["status"]): ResearchOrchestrationPhase {
    if (status === "completed") return "completed";
    if (status === "failed" || status === "timed_out" || status === "retry_exhausted") return "failed";
    if (status === "cancelled" || status === "cancelling") return "cancelled";
    return "planning";
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Research run aborted");
    }
  }

  private getSourceProviderType(source: ResearchSource): string | undefined {
    const providerType = source.metadata?.providerType;
    return typeof providerType === "string" && providerType.length > 0 ? providerType : undefined;
  }

  private async canWriteRunData(runId: string): Promise<boolean> {
    const run = await this.store.getRun(runId);
    if (!run) return false;
    return !["cancelled", "completed", "failed", "timed_out", "retry_exhausted"].includes(run.status);
  }
}
