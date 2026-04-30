import type { ResearchStore } from "@fusion/core";
import type {
  ResearchCancellationState,
  ResearchOrchestrationConfig,
  ResearchOrchestrationPhase,
  ResearchOrchestrationStep,
  ResearchRun,
  ResearchSource,
  ResearchSynthesisRequest,
} from "@fusion/core";
import { AgentSemaphore } from "./concurrency.js";
import { createLogger, formatError } from "./logger.js";
import type { ResearchStepRunnerApi } from "./research-step-runner.js";

const log = createLogger("research-orchestrator");

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
  store: ResearchStore;
  stepRunner: ResearchStepRunnerApi;
  maxConcurrentRuns?: number;
}

interface ActiveRunState {
  controller: AbortController;
  phase: ResearchOrchestrationPhase;
  stepIndex: number;
  totalSteps: number;
  config: ResearchOrchestrationConfig;
}

export class ResearchOrchestrator {
  private readonly store: ResearchStore;
  private readonly stepRunner: ResearchStepRunnerApi;
  private readonly semaphore: AgentSemaphore;
  private readonly activeRuns = new Map<string, ActiveRunState>();
  private readonly cancellation = new Map<string, ResearchCancellationState>();

  constructor(options: ResearchOrchestratorOptions) {
    this.store = options.store;
    this.stepRunner = options.stepRunner;
    this.semaphore = new AgentSemaphore(options.maxConcurrentRuns ?? 3);
  }

  createRun(config: ResearchOrchestrationConfig): string {
    const run = this.store.createRun({
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
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);

    const config = (run.providerConfig ?? {}) as unknown as ResearchOrchestrationConfig;
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

    await this.semaphore.run(async () => {
      this.store.updateRun(runId, { query, status: "running", startedAt: new Date().toISOString(), error: null });
      await this.runPhases(runId, query, config, controller.signal);
    });

    const updated = this.store.getRun(runId);
    if (!updated) throw new Error(`Research run not found after start: ${runId}`);
    return updated;
  }

  cancelRun(runId: string): boolean {
    const active = this.activeRuns.get(runId);
    if (!active) return false;

    const state: ResearchCancellationState = {
      runId,
      controller: active.controller,
      requestedAt: new Date().toISOString(),
      gracefulShutdown: true,
      reason: "Cancelled by user",
    };
    this.cancellation.set(runId, state);
    active.controller.abort(new Error("Research run cancelled"));
    return true;
  }

  retryRun(runId: string): string {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new Error(`Research run ${runId} is not retryable (status=${run.status})`);
    }

    const next = this.store.createRun({
      query: run.query,
      topic: run.topic,
      providerConfig: run.providerConfig,
      tags: [...run.tags],
      metadata: {
        ...(run.metadata ?? {}),
        retryOfRunId: run.id,
      },
    });
    this.store.addEvent(next.id, {
      type: "info",
      message: `Retry run created from ${run.id}`,
      metadata: { retryOfRunId: run.id },
    });
    return next.id;
  }

  getRunStatus(runId: string): ResearchOrchestratorStatus {
    const run = this.store.getRun(runId);
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

      this.store.updateStatus(runId, "completed");
      this.transitionPhase(runId, "completed", "Research run completed");
    } catch (err) {
      if (signal.aborted) {
        this.onCancelled(runId);
      } else {
        const { message, detail } = formatError(err);
        this.store.addEvent(runId, {
          type: "error",
          message: `Research run failed: ${message}`,
          metadata: { detail },
        });
        this.store.updateStatus(runId, "failed", { error: message });
        this.transitionPhase(runId, "failed", "Research run failed", { error: message });
      }
    } finally {
      this.activeRuns.delete(runId);
      this.cancellation.delete(runId);
    }
  }

  private async runPlanning(runId: string, query: string, config: ResearchOrchestrationConfig, _signal: AbortSignal): Promise<void> {
    this.transitionPhase(runId, "planning", "Planning research execution");
    this.stepStarted(runId, {
      id: `${runId}-planning`,
      type: "synthesis-pass",
      phase: "planning",
      status: "running",
      order: 0,
      name: "Create plan",
      input: { query, providerCount: config.providers.length },
      startedAt: new Date().toISOString(),
    });
    this.stepCompleted(runId, `${runId}-planning`, { query });
  }

  private async runSearching(
    runId: string,
    query: string,
    config: ResearchOrchestrationConfig,
    signal: AbortSignal,
  ): Promise<ResearchSource[]> {
    this.throwIfAborted(signal);
    this.transitionPhase(runId, "searching", "Searching sources");

    const allSources: ResearchSource[] = [];
    for (const provider of config.providers) {
      this.throwIfAborted(signal);
      const step = this.createStep(runId, "source-query", "searching", `Search with ${provider.type}`, {
        query,
        provider: provider.type,
      });
      this.stepStarted(runId, step);

      const result = await this.stepRunner.runSourceQuery(query, provider.type, provider.config, signal);
      if (!result.ok || !result.data) {
        this.stepFailed(runId, step.id, result.error?.message ?? `Provider ${provider.type} returned no data`, result.error);
        continue;
      }

      for (const source of result.data.slice(0, Math.max(0, config.maxSources - allSources.length))) {
        const saved = this.store.addSource(runId, source);
        allSources.push(saved);
        this.store.addEvent(runId, {
          type: "source_added",
          message: `Source found: ${saved.reference}`,
          metadata: { sourceId: saved.id, provider: provider.type },
        });
      }

      this.stepCompleted(runId, step.id, { sourceCount: result.data.length });
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
    this.transitionPhase(runId, "fetching", "Fetching source content");

    const fetched: ResearchSource[] = [];
    const provider = config.providers[0];
    for (const source of sources.slice(0, config.maxSources)) {
      this.throwIfAborted(signal);
      const step = this.createStep(runId, "content-fetch", "fetching", `Fetch ${source.reference}`, {
        sourceId: source.id,
      });
      this.stepStarted(runId, step);

      const result = await this.stepRunner.runContentFetch(source.reference, provider?.config, signal);
      if (!result.ok || !result.data) {
        this.stepFailed(runId, step.id, result.error?.message ?? "Failed to fetch source content", result.error);
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
      this.store.updateSource(runId, source.id, updated);
      fetched.push(updated);
      this.stepCompleted(runId, step.id, { fetched: true });
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
    this.transitionPhase(runId, "synthesizing", "Synthesizing findings");

    let final: { output: string; citations: string[]; confidence?: number } | undefined;

    for (let round = 1; round <= Math.max(1, config.maxSynthesisRounds); round++) {
      this.throwIfAborted(signal);
      const step = this.createStep(runId, "synthesis-pass", "synthesizing", `Synthesis round ${round}`, {
        round,
      });
      this.stepStarted(runId, step);

      const request: ResearchSynthesisRequest = {
        query,
        sources,
        round,
        desiredFormat: "markdown",
      };
      const result = await this.stepRunner.runSynthesis(request, config.synthesisModel, signal);
      if (!result.ok || !result.data) {
        this.stepFailed(runId, step.id, result.error?.message ?? "Synthesis failed", result.error);
        continue;
      }

      final = result.data;
      this.store.addEvent(runId, {
        type: "progress",
        message: `Synthesis round ${round} completed`,
        metadata: { round, confidence: result.data.confidence },
      });
      this.stepCompleted(runId, step.id, { round, citations: result.data.citations.length });
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
    this.transitionPhase(runId, "finalizing", "Finalizing research results");
    this.store.setResults(runId, {
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

  private onCancelled(runId: string): void {
    const cancellation = this.cancellation.get(runId);
    this.store.addEvent(runId, {
      type: "warning",
      message: "Research run cancelled",
      metadata: {
        requestedAt: cancellation?.requestedAt,
        reason: cancellation?.reason,
      },
    });
    this.store.updateStatus(runId, "cancelled", {
      cancelledAt: new Date().toISOString(),
      error: cancellation?.reason,
    });
    this.transitionPhase(runId, "cancelled", "Research run cancelled");
  }

  private transitionPhase(
    runId: string,
    phase: ResearchOrchestrationPhase,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    const active = this.activeRuns.get(runId);
    if (active) {
      active.phase = phase;
    }
    this.store.updateRun(runId, {
      metadata: {
        orchestration: {
          phase,
          stepIndex: active?.stepIndex ?? 0,
          totalSteps: active?.totalSteps ?? 0,
        },
      },
    });
    this.store.addEvent(runId, {
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

  private stepStarted(runId: string, step: ResearchOrchestrationStep): void {
    this.bumpStep(runId, step.order);
    this.store.addEvent(runId, {
      type: "progress",
      message: `${step.name} started`,
      metadata: {
        orchestrationEventType: "step-started",
        step,
      },
    });
  }

  private stepCompleted(runId: string, stepId: string, output?: Record<string, unknown>): void {
    this.store.addEvent(runId, {
      type: "progress",
      message: `${stepId} completed`,
      metadata: {
        orchestrationEventType: "step-completed",
        stepId,
        output,
      },
    });
  }

  private stepFailed(
    runId: string,
    stepId: string,
    errorMessage: string,
    errorMeta?: Record<string, unknown>,
  ): void {
    this.store.addEvent(runId, {
      type: "error",
      message: `${stepId} failed: ${errorMessage}`,
      metadata: {
        orchestrationEventType: "step-failed",
        stepId,
        ...(errorMeta ?? {}),
      },
    });
  }

  private bumpStep(runId: string, stepIndex: number): void {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.stepIndex = stepIndex;
    this.store.updateRun(runId, {
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

  private statusToPhase(status: ResearchRun["status"]): ResearchOrchestrationPhase {
    if (status === "completed") return "completed";
    if (status === "failed") return "failed";
    if (status === "cancelled") return "cancelled";
    return "planning";
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Research run aborted");
    }
  }
}
