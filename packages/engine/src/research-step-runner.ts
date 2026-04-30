import type {
  ResearchModelSettings,
  ResearchProviderConfig,
  ResearchSource,
  ResearchSynthesisRequest,
  ResearchSynthesisResult,
} from "@fusion/core";
import { createLogger, formatError } from "./logger.js";

const log = createLogger("research-step-runner");

const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 120_000;

export class ResearchStepTimeoutError extends Error {
  constructor(step: string, timeoutMs: number) {
    super(`${step} timed out after ${timeoutMs}ms`);
    this.name = "ResearchStepTimeoutError";
  }
}

export class ResearchStepAbortError extends Error {
  constructor(step: string) {
    super(`${step} aborted`);
    this.name = "ResearchStepAbortError";
  }
}

export class ResearchStepProviderError extends Error {
  constructor(step: string, message: string) {
    super(`${step} provider error: ${message}`);
    this.name = "ResearchStepProviderError";
  }
}

export interface ResearchProvider {
  readonly type: string;
  search(query: string, options: ResearchProviderConfig, signal?: AbortSignal): Promise<ResearchSource[]>;
  fetchContent(
    url: string,
    options: ResearchProviderConfig,
    signal?: AbortSignal,
  ): Promise<{ content: string; metadata: Record<string, unknown> }>;
  isConfigured(): boolean;
}

export interface ResearchStepResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: "provider_not_configured" | "timeout" | "aborted" | "provider_error";
    message: string;
    retryable: boolean;
  };
}

export interface ResearchStepRunnerApi {
  runSourceQuery(
    query: string,
    providerType: string,
    config?: ResearchProviderConfig,
    signal?: AbortSignal,
  ): Promise<ResearchStepResult<ResearchSource[]>>;
  runContentFetch(
    url: string,
    config?: ResearchProviderConfig,
    signal?: AbortSignal,
  ): Promise<ResearchStepResult<{ content: string; metadata: Record<string, unknown> }>>;
  runSynthesis(
    request: ResearchSynthesisRequest,
    modelSettings?: ResearchModelSettings,
    signal?: AbortSignal,
  ): Promise<ResearchStepResult<ResearchSynthesisResult>>;
}

export interface ResearchStepRunnerOptions {
  providers?: ResearchProvider[];
  synthesisRunner?: (
    request: ResearchSynthesisRequest,
    modelSettings: ResearchModelSettings,
    signal?: AbortSignal,
  ) => Promise<ResearchSynthesisResult>;
}

export class ResearchStepRunner implements ResearchStepRunnerApi {
  private readonly providers: Map<string, ResearchProvider>;
  private readonly synthesisRunner?: ResearchStepRunnerOptions["synthesisRunner"];

  constructor(options: ResearchStepRunnerOptions = {}) {
    this.providers = new Map((options.providers ?? []).map((provider) => [provider.type, provider]));
    this.synthesisRunner = options.synthesisRunner;
  }

  async runSourceQuery(
    query: string,
    providerType: string,
    config: ResearchProviderConfig = {},
    signal?: AbortSignal,
  ): Promise<ResearchStepResult<ResearchSource[]>> {
    const provider = this.providers.get(providerType);
    if (!provider || !provider.isConfigured()) {
      return this.unconfigured(`provider ${providerType} is not configured`);
    }

    try {
      const data = await this.withTimeout(
        `source-query:${providerType}`,
        provider.search(query, config, signal),
        config.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
        signal,
      );
      return { ok: true, data };
    } catch (error) {
      return this.classifyError("source-query", error);
    }
  }

  async runContentFetch(
    url: string,
    config: ResearchProviderConfig = {},
    signal?: AbortSignal,
  ): Promise<ResearchStepResult<{ content: string; metadata: Record<string, unknown> }>> {
    const provider = this.findFirstConfiguredProvider();
    if (!provider) {
      return this.unconfigured("no configured provider available for content fetch");
    }

    try {
      const data = await this.withTimeout(
        `content-fetch:${provider.type}`,
        provider.fetchContent(url, config, signal),
        config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
        signal,
      );
      return { ok: true, data };
    } catch (error) {
      return this.classifyError("content-fetch", error);
    }
  }

  async runSynthesis(
    request: ResearchSynthesisRequest,
    modelSettings: ResearchModelSettings = {},
    signal?: AbortSignal,
  ): Promise<ResearchStepResult<ResearchSynthesisResult>> {
    if (!this.synthesisRunner) {
      return this.unconfigured("synthesis provider is not configured");
    }

    try {
      const timeoutMs = modelSettings.timeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS;
      const data = await this.withTimeout(
        "synthesis",
        this.synthesisRunner(request, modelSettings, signal),
        timeoutMs,
        signal,
      );
      return { ok: true, data };
    } catch (error) {
      return this.classifyError("synthesis", error);
    }
  }

  private findFirstConfiguredProvider(): ResearchProvider | undefined {
    for (const provider of this.providers.values()) {
      if (provider.isConfigured()) return provider;
    }
    return undefined;
  }

  private classifyError<T>(step: string, error: unknown): ResearchStepResult<T> {
    if (error instanceof ResearchStepTimeoutError) {
      return { ok: false, error: { code: "timeout", message: error.message, retryable: true } };
    }
    if (error instanceof ResearchStepAbortError) {
      return { ok: false, error: { code: "aborted", message: error.message, retryable: false } };
    }

    const { message, detail } = formatError(error);
    log.warn(`${step} failed`, detail);
    return {
      ok: false,
      error: {
        code: "provider_error",
        message,
        retryable: true,
      },
    };
  }

  private unconfigured<T>(message: string): ResearchStepResult<T> {
    return {
      ok: false,
      error: {
        code: "provider_not_configured",
        message,
        retryable: false,
      },
    };
  }

  private async withTimeout<T>(
    step: string,
    promise: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new ResearchStepAbortError(step);
    }

    let timeoutId: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const abortPromise = new Promise<never>((_, reject) => {
      if (!signal) return;
      abortListener = () => reject(new ResearchStepAbortError(step));
      signal.addEventListener("abort", abortListener, { once: true });
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new ResearchStepTimeoutError(step, timeoutMs)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise, abortPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }
}
