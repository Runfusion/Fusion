import { randomUUID } from "node:crypto";

import {
  EXPERIMENT_RUN_OUTCOMES,
  type ExperimentMetricDefinition,
  type ExperimentRunOutcome,
  type ExperimentRunRecordPayload,
  type ExperimentSecondaryMetric,
  type ExperimentSession,
  type ExperimentSessionRecord,
  type ExperimentSessionStore,
} from "@fusion/core";

import { AgentSemaphore } from "./concurrency.js";
import { runBenchmark as defaultRunBenchmark, type BenchmarkRunOptions } from "./experiment/benchmark-runner.js";
import { defaultGitOps, type GitOps } from "./experiment/git-ops.js";
import { commitKept, ExperimentRevertConflictError, revertDiscarded } from "./experiment/git-policy.js";
import { parseMetricLines } from "./experiment/metric-parser.js";
import { createLogger, formatError } from "./logger.js";

export class ExperimentMaxIterationsError extends Error {}
export class ExperimentGitNotConfiguredError extends Error {}

export interface ExperimentExecutorOptions {
  store: ExperimentSessionStore;
  git?: GitOps;
  runBenchmark?: typeof defaultRunBenchmark;
  maxConcurrentExperiments?: number;
  logger?: ReturnType<typeof createLogger>;
}

export interface InitExperimentInput {
  name: string;
  metric: ExperimentMetricDefinition;
  maxIterations?: number;
  workingDir?: string;
  rules?: string;
  ideas?: string;
  projectId?: string;
  tags?: string[];
}

export interface RunExperimentInput {
  sessionId: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onProgress?: BenchmarkRunOptions["onProgress"];
}

export interface RunExperimentResult {
  runHandle: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  primaryMetric?: { name: string; value: number; unit?: string };
  secondaryMetrics: ExperimentSecondaryMetric[];
  parseWarnings: string[];
  status: "pending" | "errored";
  truncatedTempFile?: string;
}

export interface LogExperimentInput {
  sessionId: string;
  runResult: RunExperimentResult;
  outcome: ExperimentRunOutcome;
  description?: string;
  asi?: Record<string, unknown>;
  confidence?: number;
  commitMessage?: string;
  baselineCommit?: string;
}

export interface ExperimentExecutorStatus {
  sessionId: string;
  status: ExperimentSession["status"];
  currentSegment: number;
  runsInSegment: number;
  activeHandles: string[];
  maxIterations?: number;
}

export class ExperimentExecutor {
  private readonly semaphore: AgentSemaphore;
  private readonly activeRuns = new Map<string, { controller: AbortController; sessionId: string; startedAt: number }>();
  private readonly runBenchmark;
  private readonly logger;

  constructor(private readonly options: ExperimentExecutorOptions) {
    this.semaphore = new AgentSemaphore(options.maxConcurrentExperiments ?? 2);
    this.runBenchmark = options.runBenchmark ?? defaultRunBenchmark;
    this.logger = options.logger ?? createLogger("experiment-executor");
  }

  async initExperiment(input: InitExperimentInput): Promise<{ session: ExperimentSession; configRecord: ExperimentSessionRecord }> {
    const configPayload = {
      metric: input.metric,
      maxIterations: input.maxIterations,
      workingDir: input.workingDir,
      rules: input.rules,
      ideas: input.ideas,
    };

    const existing = (await this.options.store
      .listSessions({ projectId: input.projectId }))
      .find((session) => session.name === input.name && ["active", "finalizing"].includes(session.status));

    if (existing) {
      const result = await this.options.store.startNewSegment(existing.id, configPayload);
      this.logger.log(`initExperiment: ${existing.id} mode=new-segment`);
      return { session: result.session, configRecord: result.record };
    }

    const session = await this.options.store.createSession({
      name: input.name,
      projectId: input.projectId,
      metric: input.metric,
      maxIterations: input.maxIterations,
      workingDir: input.workingDir,
      tags: input.tags,
      status: "active",
      currentSegment: 1,
    });

    const configRecord = await this.options.store.appendRecord(session.id, {
      type: "config",
      payload: configPayload,
      segment: session.currentSegment,
    });

    this.logger.log(`initExperiment: ${session.id} mode=created`);
    return { session, configRecord };
  }

  async runExperiment(input: RunExperimentInput, opts?: { abortSignal?: AbortSignal }): Promise<RunExperimentResult> {
    const session = await this.options.store.getSession(input.sessionId);
    if (!session || session.status !== "active") throw new Error("Session not active");

    const runsInSegment = (await this.options.store
      .listRecords(input.sessionId, { segment: session.currentSegment, type: "run" }))
      .length;
    if (session.maxIterations !== undefined && runsInSegment >= session.maxIterations) {
      throw new ExperimentMaxIterationsError(`Session ${input.sessionId} reached max iterations`);
    }

    await this.semaphore.acquire();
    const controller = new AbortController();
    const runHandle = randomUUID();
    if (opts?.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    this.activeRuns.set(runHandle, { controller, sessionId: input.sessionId, startedAt: Date.now() });

    try {
      const benchmark = await this.runBenchmark({
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        env: input.env,
        abortSignal: controller.signal,
        onProgress: input.onProgress,
        sessionId: input.sessionId,
      });
      const parsed = parseMetricLines(benchmark.stdout);
      const status = benchmark.exitCode !== 0 || benchmark.timedOut || !parsed.primary ? "errored" : "pending";
      return {
        runHandle,
        exitCode: benchmark.exitCode,
        stdout: benchmark.stdout,
        stderr: benchmark.stderr,
        durationMs: benchmark.durationMs,
        primaryMetric: parsed.primary,
        secondaryMetrics: parsed.secondary,
        parseWarnings: parsed.warnings,
        status,
        truncatedTempFile: benchmark.truncatedTempFile,
      };
    } catch (error) {
      this.logger.error(`runExperiment failed: ${formatError(error)}`);
      throw error;
    } finally {
      this.activeRuns.delete(runHandle);
      this.semaphore.release();
    }
  }

  async logExperiment(input: LogExperimentInput): Promise<{ runRecord: ExperimentSessionRecord; commit?: string; revertedTo?: string }> {
    const session = await this.options.store.getSession(input.sessionId);
    if (!session) throw new Error(`Experiment session not found: ${input.sessionId}`);
    if (!EXPERIMENT_RUN_OUTCOMES.includes(input.outcome)) throw new Error(`Invalid outcome: ${input.outcome}`);
    if (input.outcome === "keep" && !input.runResult.primaryMetric) throw new Error("keep outcome requires primary metric");
    if (["discard", "checks_failed"].includes(input.outcome) && !input.baselineCommit) {
      throw new Error("baselineCommit is required for discard/checks_failed");
    }
    if (input.outcome === "keep" && !this.options.git) {
      throw new ExperimentGitNotConfiguredError("Git ops not configured");
    }

    const payload: ExperimentRunRecordPayload = {
      commit: undefined,
      primaryMetric: input.runResult.primaryMetric?.value ?? Number.NaN,
      secondaryMetrics: input.runResult.secondaryMetrics,
      status: input.outcome,
      description: input.description,
      confidence: input.confidence,
      asi: input.asi,
      durationMs: input.runResult.durationMs,
    };

    const runRecord = await this.options.store.appendRecord(input.sessionId, {
      type: "run",
      payload,
      segment: session.currentSegment,
    });

    let commit: string | undefined;
    let revertedTo: string | undefined;

    if (input.outcome === "keep" && this.options.git) {
      const result = await commitKept({
        session,
        runRecord,
        runPayload: payload,
        git: this.options.git,
        commitMessage: input.commitMessage,
      });
      commit = result.commit;
      await this.options.store.updateRecordPayload(runRecord.id, { commit });
      await this.options.store.setBestRun(input.sessionId, runRecord.id);
      await this.options.store.recordKept(input.sessionId, runRecord.id);
    }

    if (["discard", "checks_failed", "errored"].includes(input.outcome) && input.baselineCommit && this.options.git) {
      const result = await revertDiscarded({ session, git: this.options.git, baselineCommit: input.baselineCommit });
      revertedTo = result.revertedTo;
    }

    return { runRecord, commit, revertedTo };
  }

  async getStatus(sessionId: string): Promise<ExperimentExecutorStatus> {
    const session = await this.options.store.getSession(sessionId);
    if (!session) throw new Error(`Experiment session not found: ${sessionId}`);
    const runsInSegment = (await this.options.store
      .listRecords(sessionId, { segment: session.currentSegment, type: "run" }))
      .length;
    const activeHandles = [...this.activeRuns.entries()]
      .filter(([, value]) => value.sessionId === sessionId)
      .map(([handle]) => handle);

    return {
      sessionId,
      status: session.status,
      currentSegment: session.currentSegment,
      runsInSegment,
      activeHandles,
      maxIterations: session.maxIterations,
    };
  }

  cancel(runHandle: string): boolean {
    const active = this.activeRuns.get(runHandle);
    if (!active) return false;
    active.controller.abort();
    return true;
  }
}

export { ExperimentRevertConflictError, defaultGitOps };
